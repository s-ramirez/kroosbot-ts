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
import { ToolRegistry } from "./tools/registry.js";

export class KroosbotApp {
  private readonly store: ConversationStore;
  private readonly brain: Brain;
  private readonly memory: MemoryManager;
  private readonly tools: ToolRegistry;
  private readonly jobs: JobSupervisor;
  private readonly discord: DiscordAdapter;
  private readonly imessage: IMessageAdapter;
  private readonly expressApp = express();
  private readonly toolTrace: ToolTraceEvent[] = [];

  constructor(private readonly config: AppConfig) {
    this.store = new ConversationStore(config.app.historyLimit);
    this.memory = new MemoryManager(config.memory);
    this.tools = ToolRegistry.createBuiltIn(config, this.memory);
    this.jobs = new JobSupervisor(config);
    this.brain =
      config.brain.mode === "echo"
        ? new EchoBrain(config.brain.systemPrompt, config.brain.echoPrefix)
        : config.brain.mode === "agent-sdk"
          ? new AgentSdkBrain(config.brain, this.memory, this.tools, (event) => this.recordToolTrace(event))
          : new OpenAiCompatibleBrain(config.brain, this.memory, this.tools, (event) => this.recordToolTrace(event));
    this.discord = new DiscordAdapter(config.adapters.discord);
    this.imessage = new IMessageAdapter(config.adapters.imessage);
    this.expressApp.use(express.json({ limit: "2mb" }));
  }

  async start(): Promise<void> {
    await this.memory.initialize();
    await this.jobs.initialize();

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
      await this.discord.ping();
      await this.discord.start((message) => this.handleInbound(message));
    }
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
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

    await this.tryAutoRemember(message);

    const history = this.store.historyFor(message.sessionKey);
    const outbound = await this.brain.reply(message, history);
    if (!outbound) return;

    await this.sendReply(message, outbound);
    this.store.appendAssistantMessage(message.sessionKey, outbound.text);
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
          text: jobs.slice(0, 10).map((job) =>
            `- ${job.id} [${job.status}] ${job.title} (${job.jobBranch})`
          ).join("\n")
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

      const cancelMatch = text.match(/^\/job\s+cancel\s+(\S+)\s*$/i);
      if (cancelMatch) {
        const job = await this.jobs.cancelJob(cancelMatch[1] ?? "");
        return { text: `Canceled job ${job.id}.` };
      }

      const retryMatch = text.match(/^\/job\s+retry\s+(\S+)\s*$/i);
      if (retryMatch) {
        const job = await this.jobs.retryJob(retryMatch[1] ?? "");
        return { text: `Retried job ${job.id} on branch ${job.jobBranch}.` };
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
    const reviewBrain = this.createReviewBrain();
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
    if (parsed.decision === "request_changes") {
      await this.jobs.markReviewOutcome(jobId, parsed.decision, parsed.summary, false);
      const restartedJob = await this.jobs.continueJobWithReview(jobId, parsed.summary);
      return [
        `Review recommendation for ${jobId}: ${parsed.decision}`,
        parsed.summary,
        "",
        `Automatically restarted job ${restartedJob.id} with revised instructions.`,
        `Use \`/job status ${restartedJob.id}\` to track the next iteration.`
      ].join("\n");
    }

    await this.jobs.markReviewOutcome(jobId, parsed.decision, parsed.summary, false);
    return `Review recommendation for ${jobId}: ${parsed.decision}\n${parsed.summary}`;
  }

  private createReviewBrain(): Brain {
    return this.config.brain.mode === "echo"
      ? new EchoBrain(this.config.brain.systemPrompt, this.config.brain.echoPrefix)
      : this.config.brain.mode === "agent-sdk"
        ? new AgentSdkBrain(this.config.brain, this.memory)
        : new OpenAiCompatibleBrain(this.config.brain, this.memory);
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
