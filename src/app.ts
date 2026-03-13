import express from "express";
import type { AppConfig } from "./config.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { IMessageAdapter } from "./adapters/imessage.js";
import { EchoBrain } from "./brain/echo.js";
import { OpenAiCompatibleBrain } from "./brain/openaiCompatible.js";
import type { ToolTraceEvent } from "./brain/openaiCompatible.js";
import type { Brain } from "./brain/types.js";
import { extractAutoMemoryCandidate } from "./memory/autoExtract.js";
import { MemoryManager } from "./memory/manager.js";
import { ConversationStore, type InboundMessage } from "./store.js";
import { ToolRegistry } from "./tools/registry.js";

export class KroosbotApp {
  private readonly store: ConversationStore;
  private readonly brain: Brain;
  private readonly memory: MemoryManager;
  private readonly tools: ToolRegistry;
  private readonly discord: DiscordAdapter;
  private readonly imessage: IMessageAdapter;
  private readonly expressApp = express();
  private readonly toolTrace: ToolTraceEvent[] = [];

  constructor(private readonly config: AppConfig) {
    this.store = new ConversationStore(config.app.historyLimit);
    this.memory = new MemoryManager(config.memory);
    this.tools = ToolRegistry.createBuiltIn(config, this.memory);
    this.brain =
      config.brain.mode === "echo"
        ? new EchoBrain(config.brain.systemPrompt, config.brain.echoPrefix)
        : new OpenAiCompatibleBrain(
            config.brain,
            this.memory,
            this.tools,
            (event) => this.recordToolTrace(event)
          );
    this.discord = new DiscordAdapter(config.adapters.discord);
    this.imessage = new IMessageAdapter(config.adapters.imessage);
    this.expressApp.use(express.json({ limit: "2mb" }));
  }

  async start(): Promise<void> {
    await this.memory.initialize();

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
}

function safeJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`;
}
