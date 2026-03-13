import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import type { MemoryManager } from "../memory/manager.js";
import type { ChatHistory, InboundMessage, OutboundMessage } from "../store.js";
import { buildSystemPrompt, compactHistoryWithoutLatestMessage } from "./prompt.js";
import type { Brain, ToolTraceEvent } from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";

export class ClaudeBrain implements Brain {
  private readonly client: Anthropic;
  private readonly cfg: AppConfig["brain"]["claude"];
  private readonly systemPrompt: string;
  private readonly historyWindow: number;
  private readonly toolConfig: AppConfig["brain"]["tools"];

  constructor(
    config: AppConfig["brain"],
    private readonly memoryManager?: MemoryManager,
    private readonly tools?: ToolRegistry,
    private readonly onToolTrace?: (event: ToolTraceEvent) => void
  ) {
    this.cfg = config.claude;
    this.systemPrompt = config.systemPrompt;
    this.historyWindow = config.historyWindow;
    this.toolConfig = config.tools;
    this.client = new Anthropic({
      apiKey: this.cfg.apiKey.trim() || undefined
    });
  }

  async reply(message: InboundMessage, history: ChatHistory): Promise<OutboundMessage | null> {
    const text = message.text.trim();
    if (!text) return null;

    const memoryResults = await this.memoryManager?.search(text);
    const toolDefs = this.toolsEnabled() ? (this.tools?.definitions() ?? []) : [];

    const systemPromptText = buildSystemPrompt(
      this.systemPrompt,
      message,
      memoryResults ?? [],
      [] // tools are passed natively, not injected into the system prompt
    );

    const historyMessages = compactHistoryWithoutLatestMessage(history, message, this.historyWindow);
    const messages: Anthropic.MessageParam[] = [
      ...historyMessages
        .filter((turn) => turn.role === "user" || turn.role === "assistant")
        .map((turn) => ({
          role: turn.role as "user" | "assistant",
          content: turn.content
        })),
      { role: "user", content: text }
    ];

    const anthropicTools: Anthropic.Tool[] = toolDefs.map((def) => ({
      name: def.name,
      description: def.description,
      input_schema: {
        type: "object" as const,
        properties: Object.fromEntries(
          def.parameters.map((param) => [
            param.name,
            { type: param.type, description: param.description }
          ])
        ),
        required: def.parameters.filter((p) => p.required).map((p) => p.name)
      }
    }));

    const maxToolSteps = this.toolsEnabled() ? this.toolConfig.maxSteps : 0;

    for (let step = 0; step <= maxToolSteps; step++) {
      console.info("sending claude chat request", {
        session: message.sessionKey.toString(),
        model: this.cfg.model,
        memoryResults: memoryResults?.length ?? 0,
        step
      });

      const response = await this.client.messages.create({
        model: this.cfg.model,
        max_tokens: this.cfg.maxOutputTokens,
        system: systemPromptText,
        messages,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {})
      });

      console.info("claude chat completed", {
        session: message.sessionKey.toString(),
        stopReason: response.stop_reason
      });

      if (response.stop_reason !== "tool_use" || step >= maxToolSteps) {
        const textBlock = response.content.find((b) => b.type === "text");
        const reply = textBlock?.type === "text" ? textBlock.text.trim() : null;
        return reply ? { text: reply } : null;
      }

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolCall of toolUseBlocks) {
        const args = toolCall.input as Record<string, unknown>;

        console.info("executing tool call", {
          session: message.sessionKey.toString(),
          tool: toolCall.name,
          arguments: args
        });

        const result = await this.tools!.execute(toolCall.name, args, {
          sessionKey: message.sessionKey.toString()
        });

        this.onToolTrace?.({
          sessionKey: message.sessionKey.toString(),
          step: step + 1,
          toolName: toolCall.name,
          arguments: args,
          ok: result.ok,
          content: result.content,
          requiresApproval: result.requiresApproval,
          approvalId: result.approvalId
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: [
            `status: ${result.ok ? "ok" : "error"}`,
            result.content,
            "Use this result to continue. If you need another tool, use it. Otherwise reply with the final answer."
          ].join("\n"),
          is_error: !result.ok
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    throw new Error(`tool loop exceeded ${maxToolSteps} steps without a final answer`);
  }

  private toolsEnabled(): boolean {
    const definitions = this.tools?.definitions() ?? [];
    return this.toolConfig.enabled && definitions.length > 0;
  }
}
