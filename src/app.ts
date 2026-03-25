import express from "express";
import type { AppConfig } from "./config.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { IMessageAdapter } from "./adapters/imessage.js";
import { AgentSdkBrain } from "./brain/agentSdk.js";
import { EchoBrain } from "./brain/echo.js";
import { OpenAiCompatibleBrain } from "./brain/openaiCompatible.js";
import type { Brain, ToolTraceEvent } from "./brain/types.js";
import { extractAutoMemoryCandidate } from "./memory/autoExtract.js";
import { MemoryManager } from "./memory/manager.js";
import { ConversationStore, SessionKey, type InboundMessage } from "./store.js";
import { JobSupervisor } from "./jobs/supervisor.js";
import type { JobDelegatePayload, JobReviewDecision } from "./jobs/types.js";
import { PlanManager } from "./plans/manager.js";
import { loadWorkspaceSkills } from "./skills/loader.js";
import { createCoreSkills } from "./skills/registry.js";
import type { SkillDefinition } from "./skills/types.js";
import { SubagentManager } from "./agents/manager.js";
import { ToolRegistry } from "./tools/registry.js";

export class KroosbotApp {
  private readonly store: ConversationStore;
  private brain!: Brain;
  private readonly memory: MemoryManager;
  private tools!: ToolRegistry;
  private agents!: SubagentManager;
  private readonly jobs: JobSupervisor;
  private readonly plans: PlanManager;
  private skills: SkillDefinition[] = [];
  private workspaceSkillNames: string[] = [];
  private readonly discord: DiscordAdapter;
  private readonly imessage: IMessageAdapter;
  private readonly expressApp = express();
  private readonly toolTrace: ToolTraceEvent[] = [];
  private readonly heartbeatHandledStates = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatRunning = false;
  private activeInboundCount = 0;

  constructor(private readonly config: AppConfig) {
    this.store = new ConversationStore(config.app.historyLimit);
    this.memory = new MemoryManager(config.memory);
    this.jobs = new JobSupervisor(config);
    this.plans = new PlanManager();
    this.discord = new DiscordAdapter(config.adapters.discord);
    this.imessage = new IMessageAdapter(config.adapters.imessage);
    this.expressApp.use(express.json({ limit: "2mb" }));
  }

  async start(): Promise<void> {
    await this.memory.initialize();
    await this.jobs.initialize();
    await this.initializeAssistantRuntime();

    // Finalize the SubagentManager with the real brain and tools
    this.agents.setDefaults(this.brain, this.tools);
    await this.agents.initialize();
    await this.agents.loadAll();

    this.expressApp.get("/healthz", (_req, res) => {
      res.json({ ok: true });
    });

    if (this.config.adapters.imessage.enabled) {
      await this.imessage.ping();
      this.imessage.registerWebhook(this.expressApp, (message) => this.handleInbound(message));
    }

    await new Promise<void>((resolve) => {
      this.expressApp.listen(this.config.app.listenPort, () => {
        console.info("starting kroosbot-ts", { port: this.config.app.listenPort });
        resolve();
      });
    });

    if (this.config.adapters.discord.enabled) {
      try {
        await this.discord.ping();
      } catch (error) {
        console.warn("discord ping failed during startup; continuing with gateway login", error);
      }
      await this.discord.start((message) => this.handleInbound(message));
    }

    this.startHeartbeat();
  }

  private async initializeAssistantRuntime(): Promise<void> {
    const workspaceSkills = await loadWorkspaceSkills({
      config: this.config,
      memory: this.memory,
      jobs: this.jobs,
      plans: this.plans,
      reviewJob: (jobId) => this.reviewJob(jobId)
    });
    this.skills = [
      ...createCoreSkills(this.config),
      ...workspaceSkills.map((skill) => skill.definition)
    ];
    this.workspaceSkillNames = workspaceSkills.map((skill) => skill.definition.name);
    // Create a placeholder SubagentManager so agent tools can reference it.
    // It gets fully initialized (brain, loadAll) in start() after the brain is ready.
    this.agents = new SubagentManager(
      this.config,
      // Temporary: default brain will be set after construction below
      null as unknown as Brain,
      this.memory,
      null as unknown as ToolRegistry,
      this.skills,
      (event) => this.recordToolTrace(event)
    );
    this.tools = ToolRegistry.createBuiltIn(this.config, this.memory, {
      jobs: this.jobs,
      plans: this.plans,
      reviewJob: (jobId) => this.reviewJob(jobId),
      getLoadedSkillNames: () => [...this.workspaceSkillNames],
      reloadRuntime: () => this.reloadAssistantRuntime(),
      agents: this.config.agents.enabled ? this.agents : undefined,
      extraTools: workspaceSkills.flatMap((skill) => skill.tools)
    });
    this.brain =
      this.config.brain.mode === "echo"
        ? new EchoBrain(this.config.brain.systemPrompt, this.config.brain.echoPrefix)
        : this.config.brain.mode === "agent-sdk"
          ? new AgentSdkBrain(
              this.config.brain,
              this.config.app.workspaceDir,
              this.memory,
              this.tools,
              this.skills,
              (event) => this.recordToolTrace(event)
            )
          : new OpenAiCompatibleBrain(
              this.config.brain,
              this.config.app.workspaceDir,
              this.memory,
              this.tools,
              this.skills,
            (event) => this.recordToolTrace(event)
          );
  }

  private async reloadAssistantRuntime(): Promise<void> {
    await this.initializeAssistantRuntime();
    console.info("assistant runtime reloaded", {
      workspaceSkills: this.workspaceSkillNames.length,
      toolCount: this.tools.definitions().length,
      brainMode: this.config.brain.mode
    });
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    this.activeInboundCount += 1;
    try {
      const dedupeKey = ConversationStore.dedupeKey(message);
      if (this.store.isDuplicate(dedupeKey)) return;

      this.store.rememberMessageId(dedupeKey);
      this.store.appendUserMessage(message);

      const memorySearchReply = await this.tryHandleMemorySearchCommand(message);
      if (memorySearchReply) {
        await this.sendReply(message, memorySearchReply);
        this.store.appendAssistantMessage(message.sessionKey, memorySearchReply.text);
        return;
      }

      const memoryReply = await this.tryHandleMemoryCommand(message);
      if (memoryReply) {
        await this.sendReply(message, memoryReply);
        this.store.appendAssistantMessage(message.sessionKey, memoryReply.text);
        return;
      }

      const toolsReply = await this.tryHandleToolsCommand(message);
      if (toolsReply) {
        await this.sendReply(message, toolsReply);
        this.store.appendAssistantMessage(message.sessionKey, toolsReply.text);
        return;
      }

      const agentReply = await this.tryHandleAgentCommand(message);
      if (agentReply) {
        await this.sendReply(message, agentReply);
        this.store.appendAssistantMessage(message.sessionKey, agentReply.text);
        return;
      }

      await this.tryAutoRemember(message);

      const history = this.store.historyFor(message.sessionKey);
      const brain = this.agents.brainFor(message.sessionKey.toString());
      let outbound;
      try {
        outbound = await brain.reply(message, history);
      } catch (error) {
        console.error("brain reply failed", {
          session: message.sessionKey.toString(),
          error
        });
        outbound = {
          text: "I ran into an internal error while working on that. Please try again in a moment."
        };
      }
      if (!outbound) return;

      await this.sendReply(message, outbound);
      this.store.appendAssistantMessage(message.sessionKey, outbound.text);
    } finally {
      this.activeInboundCount = Math.max(0, this.activeInboundCount - 1);
    }
  }

  private async tryHandleMemoryCommand(
    message: InboundMessage
  ): Promise<{ text: string } | null> {
    const text = message.text.trim();
    if (!text.toLowerCase().startsWith("/remember ")) {
      return null;
    }

    const note = text.slice("/remember ".length).trim();
    if (!note) {
      return { text: "Tell me what to remember after `/remember`." };
    }

    const targetPath = await this.memory.appendNote(note, {
      source: message.adapter,
      sessionKey: message.sessionKey.toString()
    });
    return {
      text: "Saved to memory." +
        (note.includes(":")
          ? ` Stored in ${targetPath}.`
          : " Tip: you can also use `/remember preference: ...`, `/remember todo: ...`, or `/remember decision: ...`.")
    };
  }

  private async tryHandleMemorySearchCommand(
    message: InboundMessage
  ): Promise<{ text: string } | null> {
    const text = message.text.trim();
    if (!text.toLowerCase().startsWith("/memory search ")) {
      return null;
    }

    const query = text.slice("/memory search ".length).trim();
    if (!query) {
      return { text: "Tell me what to search for after `/memory search`." };
    }

    const results = await this.memory.search(query);
    if (results.length === 0) {
      return { text: `No memory results found for "${query}".` };
    }

    const lines = results.map((entry, index) => {
      const suffix = entry.endLine > entry.startLine ? `-L${entry.endLine}` : "";
      const label = [
        entry.category ? `[${entry.category}]` : null,
        entry.title ?? null
      ]
        .filter(Boolean)
        .join(" ");
      return [
        `${index + 1}. ${entry.path}#L${entry.startLine}${suffix} (score ${entry.score})${label ? ` ${label}` : ""}`,
        entry.snippet
      ].join("\n");
    });

    return {
      text: `Memory results for "${query}":\n\n${lines.join("\n\n")}`
    };
  }

  private async tryAutoRemember(message: InboundMessage): Promise<void> {
    const autoConfig = this.config.memory.autoRemember;
    if (!this.memory.enabled || !autoConfig.enabled) {
      return;
    }

    const candidate = extractAutoMemoryCandidate(message.text);
    if (!candidate) {
      return;
    }
    if (!autoConfig.categories.includes(candidate.category)) {
      return;
    }

    const exists = await this.memory.hasSimilarNote(candidate.text, candidate.category);
    if (exists) {
      return;
    }

    await this.memory.appendNote(
      {
        category: candidate.category,
        text: candidate.text,
        source: message.adapter,
        sessionKey: message.sessionKey.toString()
      }
    );
    console.info("auto-remembered memory note", {
      category: candidate.category,
      text: candidate.text,
      session: message.sessionKey.toString()
    });
  }

  private async tryHandleToolsCommand(
    message: InboundMessage
  ): Promise<{ text: string } | null> {
    const text = message.text.trim();
    const lower = text.toLowerCase();

    const jobReply = await this.tryHandleJobCommand(message);
    if (jobReply) {
      return jobReply;
    }

    if (lower === "/tools") {
      const lines = this.tools.definitions().map((tool) => {
        const params = tool.parameters
          .map((param) => `${param.name}${param.required ? "*" : ""}`)
          .join(", ");
        const approval = (tool.approvalMode ?? "none") === "always"
          ? " [approval required]"
          : "";
        return `- ${tool.name}: ${tool.description}${params ? ` (${params})` : ""}${approval}`;
      });
      return {
        text: lines.length > 0
          ? `Available tools:\n${lines.join("\n")}`
          : "No tools are currently registered."
      };
    }

    if (lower === "/approvals") {
      const pending = this.tools.listPendingApprovals(message.sessionKey.toString());
      if (pending.length === 0) {
        return { text: "No pending approvals for this session." };
      }
      const lines = pending.map((entry) =>
        `- ${entry.id}: ${entry.toolName} args=${safeJson(entry.arguments)} requested=${entry.requestedAt}`
      );
      return { text: `Pending approvals:\n${lines.join("\n")}` };
    }

    const approveMatch = text.match(/^\/approve\s+(\S+)\s*$/i);
    if (approveMatch) {
      const approvalId = approveMatch[1] ?? "";
      const result = await this.tools.approve(approvalId);
      this.recordToolTrace({
        sessionKey: message.sessionKey.toString(),
        step: 0,
        toolName: result.toolName,
        arguments: {},
        ok: result.ok,
        content: `Approved ${approvalId}: ${result.content}`
      });
      return {
        text: result.ok
          ? `Approved ${approvalId} for ${result.toolName}.\n${result.content}`
          : result.content
      };
    }

    const denyMatch = text.match(/^\/deny\s+(\S+)\s*$/i);
    if (denyMatch) {
      const approvalId = denyMatch[1] ?? "";
      const denied = this.tools.deny(approvalId);
      if (!denied) {
        return { text: `No pending approval found for ${approvalId}.` };
      }
      this.recordToolTrace({
        sessionKey: denied.sessionKey,
        step: 0,
        toolName: denied.toolName,
        arguments: denied.arguments,
        ok: false,
        content: `Denied ${approvalId}`
      });
      return { text: `Denied ${approvalId} for ${denied.toolName}.` };
    }

    if (!lower.startsWith("/tool trace")) {
      return null;
    }

    const countMatch = text.match(/^\/tool trace(?:\s+(\d+))?\s*$/i);
    const requestedCount = Number.parseInt(countMatch?.[1] ?? "5", 10);
    const count = Number.isFinite(requestedCount)
      ? Math.min(Math.max(requestedCount, 1), 20)
      : 5;
    const traces = this.toolTrace
      .filter((entry) => entry.sessionKey === message.sessionKey.toString())
      .slice(-count)
      .reverse();

    if (traces.length === 0) {
      return { text: "No recent tool activity for this session." };
    }

    const lines = traces.map((entry, index) => [
      `${index + 1}. step ${entry.step} ${entry.toolName} [${entry.ok ? "ok" : "error"}]`,
      `args: ${safeJson(entry.arguments)}`,
      entry.requiresApproval ? `approval: pending ${entry.approvalId ?? "unknown"}` : null,
      `result: ${clampText(entry.content, 500)}`
    ].filter(Boolean).join("\n"));

    return {
      text: `Recent tool activity for ${message.sessionKey.toString()}:\n\n${lines.join("\n\n")}`
    };
  }

  private async tryHandleAgentCommand(
    message: InboundMessage
  ): Promise<{ text: string } | null> {
    try {
      const text = message.text.trim();
      const lower = text.toLowerCase();

      // /agents or /agent list — list all agents
      if (lower === "/agents" || lower === "/agent list") {
        const agents = await this.agents.listAgents();
        if (agents.length === 0) {
          return { text: "No agents configured." };
        }
        const lines = agents.map((agent) =>
          `- ${agent.id}: ${agent.name} [${agent.model}, ${agent.brainMode}]`
        );
        return { text: `Sub-agents (background workers):\n${lines.join("\n")}` };
      }

      // /agent create <json> — create a new agent
      if (lower.startsWith("/agent create ")) {
        const raw = text.slice("/agent create ".length).trim();
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return { text: "Invalid JSON. Usage: `/agent create {\"name\":\"Researcher\",\"model\":\"claude-opus-4-6\"}`" };
        }
        if (!payload.name || !payload.model) {
          return { text: "Agent payload must include at least `name` and `model`." };
        }
        const agent = await this.agents.createAgent(
          payload as Parameters<SubagentManager["createAgent"]>[0],
          message.sessionKey.toString()
        );
        return { text: `Created agent ${agent.id} (${agent.name}) with model ${agent.model}.` };
      }


      // /agent info <id> — show agent configuration
      const infoMatch = text.match(/^\/agent\s+info\s+(\S+)\s*$/i);
      if (infoMatch) {
        const id = infoMatch[1] ?? "";
        const agent = await this.agents.getAgent(id);
        if (!agent) {
          return { text: `Agent "${id}" not found.` };
        }
        return { text: JSON.stringify(agent, null, 2) };
      }

      // /agent delete <id> — remove an agent
      const deleteMatch = text.match(/^\/agent\s+delete\s+(\S+)\s*$/i);
      if (deleteMatch) {
        const id = deleteMatch[1] ?? "";
        const agent = await this.agents.getAgent(id);
        if (!agent) {
          return { text: `Agent "${id}" not found.` };
        }
        await this.agents.deleteAgent(id);
        return { text: `Deleted agent ${id}.` };
      }

      // /agent soul <id> <text> — set SOUL.md content for an agent
      const soulMatch = text.match(/^\/agent\s+soul\s+(\S+)\s+([\s\S]+)$/i);
      if (soulMatch) {
        const id = soulMatch[1] ?? "";
        const content = soulMatch[2]?.trim() ?? "";
        if (!content) {
          return { text: "Provide soul content after the agent id." };
        }
        await this.agents.setSoul(id, content);
        return { text: `Updated SOUL for agent ${id}.` };
      }

      return null;
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async tryHandleJobCommand(
    message: InboundMessage
  ): Promise<{ text: string } | null> {
    try {
      const text = message.text.trim();
      const lower = text.toLowerCase();

      if (lower === "/jobs") {
        const jobs = await this.jobs.listJobs();
        if (jobs.length === 0) {
          return { text: "No background jobs yet." };
        }
        return {
          text: jobs.slice(0, 10).map((job) => {
            const lines = [
              `**${job.title}** [${job.status}]`,
              `  ID: ${job.id}`,
              `  Branch: ${job.jobBranch}`,
              `  Model: ${job.modelConfig.provider}/${job.modelConfig.model}`,
              job.agentId ? `  Agent: ${job.agentId}` : null,
              job.resultSummary ? `  Summary: ${job.resultSummary.split("\n")[0]}` : null,
              job.blockerQuestion ? `  Blocker: ${job.blockerQuestion}` : null
            ];
            return lines.filter(Boolean).join("\n");
          }).join("\n\n")
        };
      }

      if (lower === "/delegate help") {
        return {
          text: [
            "Use `/delegate <json>` with a payload like:",
            '{',
            '  "title": "Implement job system",',
            '  "summary": "Build the feature in the target repo.",',
            '  "checklist": ["Add store", "Add worker"],',
            '  "acceptanceCriteria": ["Jobs persist", "Worker can run"],',
            '  "checkCommands": ["bun run build"],',
            `  "provider": "${this.config.jobs.defaultProvider}",`,
            `  "model": "${this.config.jobs.defaultModel || this.config.brain.openAiCompatible.model}",`,
            `  "workspaceDir": "${this.config.app.workspaceDir}"`,
            '}'
          ].join("\n")
        };
      }

      if (lower.startsWith("/delegate ")) {
        if (!this.config.jobs.enabled) {
          return { text: "Jobs are disabled in config." };
        }
        const raw = text.slice("/delegate ".length).trim();
        let payload: JobDelegatePayload;
        try {
          payload = JSON.parse(raw) as JobDelegatePayload;
        } catch {
          return { text: "Invalid delegate payload. Use `/delegate help` for the expected JSON shape." };
        }
        const job = await this.jobs.createAndStartJob(payload, message.sessionKey.toString());
        return {
          text: `Started job ${job.id} on branch ${job.jobBranch}.\nUse \`/job status ${job.id}\` to track it.`
        };
      }

      const statusMatch = text.match(/^\/job\s+status\s+(\S+)\s*$/i);
      if (statusMatch) {
        return { text: await this.jobs.getJobStatusReport(statusMatch[1] ?? "") };
      }

      const logMatch = text.match(/^\/job\s+log\s+(\S+)\s*$/i);
      if (logMatch) {
        const log = await this.jobs.getJobLog(logMatch[1] ?? "");
        return { text: log || "No worker log yet." };
      }

      const clearMatch = text.match(/^\/job\s+clear\s+(\S+)\s*$/i);
      if (clearMatch) {
        const job = await this.jobs.clearJob(clearMatch[1] ?? "");
        return { text: `Cleared job ${job.id} (${job.status}).` };
      }

      const clearManyMatch = text.match(/^\/jobs\s+clear(?:\s+(blocked|failed|all|problems))?\s*$/i);
      if (clearManyMatch) {
        const target = (clearManyMatch[1] ?? "all").toLowerCase();
        const statuses: Array<"blocked" | "failed"> = target === "blocked"
          ? ["blocked"]
          : target === "failed"
            ? ["failed"]
            : ["blocked", "failed"];
        const cleared = await this.jobs.clearJobs(statuses);
        return {
          text: cleared.length > 0
            ? `Cleared ${cleared.length} job(s): ${cleared.map((job) => `${job.id} [${job.status}]`).join(", ")}`
            : `No ${statuses.join("/")} jobs to clear.`
        };
      }

      const cancelMatch = text.match(/^\/job\s+cancel\s+(\S+)\s*$/i);
      if (cancelMatch) {
        const job = await this.jobs.cancelJob(cancelMatch[1] ?? "");
        return { text: `Canceled job ${job.id}.` };
      }

      const retryMatch = text.match(/^\/job\s+retry\s+(\S+)\s*$/i);
      if (retryMatch) {
        const existingJob = await this.jobs.getJob(retryMatch[1] ?? "");
        const agentConfig = this.config.agents.enabled && existingJob?.agentId
          ? await this.agents.resolveJobModelConfig(existingJob.plannerSessionKey, existingJob.agentId)
          : undefined;
        const job = await this.jobs.retryJob(retryMatch[1] ?? "", agentConfig);
        return {
          text: `Retried job ${job.id} on branch ${job.jobBranch} with model ${job.modelConfig.provider}/${job.modelConfig.model}.`
        };
      }

      const approveMatch = text.match(/^\/job\s+approve\s+(\S+)\s*$/i);
      if (approveMatch) {
        const job = await this.jobs.markReviewOutcome(approveMatch[1] ?? "", "approve", "Approved by main assistant.");
        return { text: `Approved job ${job.id}.` };
      }

      const rejectMatch = text.match(/^\/job\s+reject\s+(\S+)\s*$/i);
      if (rejectMatch) {
        const job = await this.jobs.markReviewOutcome(rejectMatch[1] ?? "", "reject", "Rejected by main assistant.");
        return { text: `Rejected job ${job.id} and reset branch ${job.jobBranch} to ${job.baseCommit}.` };
      }

      const reviewMatch = text.match(/^\/job\s+review\s+(\S+)\s*$/i);
      if (reviewMatch) {
        const review = await this.reviewJob(reviewMatch[1] ?? "");
        return { text: review };
      }

      return null;
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async sendReply(message: InboundMessage, outbound: { text: string }): Promise<void> {
    console.info("sending reply", {
      adapter: message.deliveryTarget.adapter,
      target: message.deliveryTarget.address,
      length: outbound.text.length
    });
    if (message.deliveryTarget.adapter === "discord") {
      await this.discord.sendText(message, outbound);
    } else {
      await this.imessage.sendText(message, outbound);
    }
  }

  private recordToolTrace(event: ToolTraceEvent): void {
    this.toolTrace.push(event);
    while (this.toolTrace.length > 200) {
      this.toolTrace.shift();
    }
  }

  private async reviewJob(jobId: string): Promise<string> {
    const context = await this.jobs.collectReviewContext(jobId);
    const reviewBrain = this.brain;
    const reviewMessage: InboundMessage = {
      adapter: "discord",
      chatKind: "direct",
      messageId: `review-${jobId}-${Date.now()}`,
      sessionKey: new SessionKey(context.job.plannerSessionKey || "job-review:synthetic"),
      conversationId: "job-review",
      deliveryTarget: {
        adapter: "discord",
        address: "job-review"
      },
      senderId: "main-assistant",
      senderName: "Main Assistant",
      text: buildReviewPrompt(context)
    };
    const reply = await reviewBrain.reply(reviewMessage, { turns: [] });
    const parsed = parseReviewDecision(reply?.text ?? "");
    const title = context.job.title;

    if (parsed.decision === "approve") {
      await this.jobs.markReviewOutcome(jobId, parsed.decision, parsed.summary, true);
      return [
        `I reviewed "${title}" and approved it.`,
        parsed.summary
      ].join("\n\n");
    }

    if (parsed.decision === "request_changes") {
      await this.jobs.markReviewOutcome(jobId, parsed.decision, parsed.summary, false);
      const restartedJob = await this.jobs.continueJobWithReview(jobId, parsed.summary);
      return [
        `I reviewed "${title}" and asked for changes.`,
        parsed.summary,
        "",
        `I already restarted the worker with revised instructions on job ${restartedJob.id}.`
      ].join("\n");
    }

    await this.jobs.markReviewOutcome(jobId, parsed.decision, parsed.summary, false);
    return [
      `I reviewed "${title}" and I think we should reject it.`,
      parsed.summary,
      "",
      `I have not reset the branch yet. If you want, I can reject it next.`
    ].join("\n");
  }

  private startHeartbeat(): void {
    if (!this.config.initiative.enabled) return;
    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat();
    }, this.config.initiative.heartbeatIntervalMs);
  }

  private async runHeartbeat(): Promise<void> {
    if (this.heartbeatRunning || this.activeInboundCount > 0) {
      return;
    }
    this.heartbeatRunning = true;
    try {
      const jobs = await this.jobs.listJobs();
      for (const job of jobs) {
        const handledKey = `${job.id}:${job.status}:${job.reviewIterationCount ?? 0}`;
        if (this.heartbeatHandledStates.has(handledKey)) {
          continue;
        }

        if (job.status === "ready_for_review" && this.config.initiative.autoReviewReadyJobs) {
          const reviewText = await this.reviewJob(job.id);
          await this.notifyJobSession(job.plannerSessionKey, reviewText);
          this.heartbeatHandledStates.add(handledKey);
          continue;
        }

        if (job.status === "blocked" && this.config.initiative.notifyBlockedJobs) {
          const lines = [`Quick update on "${job.title}": it needs attention.`];
          if (job.blockerQuestion) {
            lines.push(job.blockerQuestion);
          }
          if (job.resultSummary) {
            lines.push(job.resultSummary);
          }
          await this.notifyJobSession(job.plannerSessionKey, lines.join("\n\n"));
          this.heartbeatHandledStates.add(handledKey);
        }
      }
    } catch (error) {
      console.warn("heartbeat run failed", error);
    } finally {
      this.heartbeatRunning = false;
    }
  }

  private async notifyJobSession(sessionKeyRaw: string, text: string): Promise<void> {
    if (!sessionKeyRaw.trim()) return;
    const session = this.store.sessionFor(sessionKeyRaw);
    if (!session) return;

    const syntheticMessage: InboundMessage = {
      adapter: session.lastDelivery.adapter,
      chatKind: session.origin.chatKind,
      messageId: `heartbeat-${Date.now()}`,
      sessionKey: session.key,
      conversationId: session.origin.conversationId,
      threadId: session.origin.threadId,
      deliveryTarget: session.lastDelivery,
      senderId: "heartbeat",
      senderName: "Kroosbot Heartbeat",
      text
    };

    await this.sendReply(syntheticMessage, { text });
    this.store.appendAssistantMessage(session.key, text);
  }
}

function safeJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function buildReviewPrompt(context: Awaited<ReturnType<JobSupervisor["collectReviewContext"]>>): string {
  return [
    "Review this background coding job and return JSON only:",
    '{"decision":"approve|request_changes|reject","summary":"short explanation"}',
    "",
    `Title: ${context.job.title}`,
    `Status: ${context.job.status}`,
    "",
    "Acceptance criteria:",
    ...context.job.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "Checks:",
    ...(context.job.checkResults.length > 0
      ? context.job.checkResults.map((entry) => `- ${entry.ok ? "PASS" : "FAIL"} ${entry.command}: ${entry.output}`)
      : ["- No checks recorded."]),
    "",
    `Git status:\n${context.statusShort || "(clean)"}`,
    "",
    `Diff stat:\n${context.diffStat || "(no diff stat)"}`,
    "",
    `Changed files:\n${context.changedFiles.join("\n") || "(none)"}`,
    "",
    `Diff excerpt:\n${clampText(context.diff || "(no diff)", 12000)}`
  ].join("\n");
}

function parseReviewDecision(raw: string): { decision: JobReviewDecision; summary: string } {
  const trimmed = raw.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(trimmed.slice(first, last + 1)) as {
        decision?: JobReviewDecision;
        summary?: string;
      };
      if (parsed.decision === "approve" || parsed.decision === "request_changes" || parsed.decision === "reject") {
        return {
          decision: parsed.decision,
          summary: parsed.summary?.trim() || "No review summary provided."
        };
      }
    } catch {
      // ignore
    }
  }
  return {
    decision: "request_changes",
    summary: trimmed || "Review output was not structured; defaulting to request_changes."
  };
}
