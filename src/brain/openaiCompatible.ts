import { setTimeout as sleep } from "node:timers/promises";
import type { AppConfig } from "../config.js";
import type { MemoryManager } from "../memory/manager.js";
import type { SkillDefinition } from "../skills/types.js";
import type { ChatHistory, InboundMessage, OutboundMessage } from "../store.js";
import { loadWorkspaceContext } from "../workspace/context.js";
import { buildSystemPrompt, compactHistoryWithoutLatestMessage } from "./prompt.js";
import type { Brain, ToolTraceEvent } from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";

type ChatCompletionRequest = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  max_tokens: number;
  stream: false;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export class OpenAiCompatibleBrain implements Brain {
  private readonly cfg: AppConfig["brain"]["openAiCompatible"];
  private readonly workspaceDir: string;
  private readonly systemPrompt: string;
  private readonly historyWindow: number;
  private readonly toolConfig: AppConfig["brain"]["tools"];

  constructor(
    config: AppConfig["brain"],
    workspaceDir: string,
    private readonly memoryManager?: MemoryManager,
    private readonly tools?: ToolRegistry,
    private readonly skills: SkillDefinition[] = [],
    private readonly onToolTrace?: (event: ToolTraceEvent) => void,
    private readonly soulOverride?: string
  ) {
    this.cfg = config.openAiCompatible;
    this.workspaceDir = workspaceDir;
    this.systemPrompt = config.systemPrompt;
    this.historyWindow = config.historyWindow;
    this.toolConfig = config.tools;
  }

  async reply(message: InboundMessage, history: ChatHistory): Promise<OutboundMessage | null> {
    const text = message.text.trim();
    if (!text) return null;
    if (!this.cfg.model.trim()) {
      throw new Error("brain.openAiCompatible.model is empty");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);

    try {
      const memoryResults = await this.memoryManager?.search(text);
      const toolMessages: Array<{ role: string; content: string }> = [];
      const maxToolSteps = this.toolsEnabled()
        ? this.toolConfig.maxSteps
        : 0;

      for (let step = 0; step <= maxToolSteps; step += 1) {
        const content = await this.requestCompletion(message, history, memoryResults ?? [], toolMessages, controller.signal);
        if (!content) {
          return null;
        }

        const toolCall = step < maxToolSteps ? extractToolCall(content) : null;
        if (!toolCall) {
          return { text: content };
        }

        if (!this.tools?.has(toolCall.name)) {
          this.onToolTrace?.({
            sessionKey: message.sessionKey.toString(),
            step: step + 1,
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            ok: false,
            content: `Unknown tool: ${toolCall.name}`
          });
          toolMessages.push(
            { role: "assistant", content },
            { role: "user", content: `Tool execution failed.\nUnknown tool: ${toolCall.name}\nPlease continue without it or choose another tool.` }
          );
          continue;
        }

        console.info("executing tool call", {
          session: message.sessionKey.toString(),
          tool: toolCall.name,
          arguments: toolCall.arguments
        });
        const result = await this.tools.execute(toolCall.name, toolCall.arguments, {
          sessionKey: message.sessionKey.toString()
        });
        this.onToolTrace?.({
          sessionKey: message.sessionKey.toString(),
          step: step + 1,
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          ok: result.ok,
          content: result.content,
          requiresApproval: result.requiresApproval,
          approvalId: result.approvalId
        });
        toolMessages.push(
          { role: "assistant", content },
          {
            role: "user",
            content: [
              `Tool result for ${toolCall.name}:`,
              `status: ${result.ok ? "ok" : "error"}`,
              result.content,
              "Use this result to continue. If you need another tool, emit another JSON tool call. Otherwise reply with the final answer."
            ].join("\n")
          }
        );
      }
      throw new Error(`tool loop exceeded ${maxToolSteps} steps without a final answer`);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(`openai-compatible chat timed out after ${this.cfg.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      await sleep(0);
    }
  }

  private async requestCompletion(
    message: InboundMessage,
    history: ChatHistory,
    memoryResults: Awaited<ReturnType<MemoryManager["search"]>>,
    toolMessages: Array<{ role: string; content: string }>,
    signal: AbortSignal
  ): Promise<string | null> {
    const payload: ChatCompletionRequest = {
      model: this.cfg.model,
      messages: [],
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxOutputTokens,
      stream: false
    };
    const workspaceContext = await loadWorkspaceContext(this.workspaceDir);
    payload.messages = [
      {
        role: "system",
        content: buildSystemPrompt(
          this.systemPrompt,
          message,
          memoryResults ?? [],
          this.toolsEnabled() ? this.tools?.definitions() ?? [] : [],
          this.skills,
          workspaceContext,
          this.soulOverride
        )
      },
      ...compactHistoryWithoutLatestMessage(history, message, this.historyWindow),
      { role: "user", content: message.text.trim() },
      ...toolMessages
    ];

    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.cfg.apiKey.trim()) {
      headers.authorization = `Bearer ${this.cfg.apiKey.trim()}`;
    }

    const endpoint = resolveChatCompletionsUrl(this.cfg.baseUrl);
    console.info("sending openai-compatible chat request", {
      session: message.sessionKey.toString(),
      model: this.cfg.model,
      endpoint,
      memoryResults: memoryResults?.length ?? 0,
      toolMessages: toolMessages.length
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn("openai-compatible chat returned error", {
        session: message.sessionKey.toString(),
        status: response.status,
        body
      });
      throw new Error(`openai-compatible chat failed (${response.status}): ${body}`);
    }

    const body = (await response.json()) as ChatCompletionResponse;
    const content = sanitizeAssistantText(body.choices?.[0]?.message?.content);
    console.info("openai-compatible chat completed", {
      session: message.sessionKey.toString(),
      hasReply: Boolean(content)
    });
    return content;
  }

  private toolsEnabled(): boolean {
    const definitions = this.tools?.definitions() ?? [];
    return this.toolConfig.enabled && definitions.length > 0;
  }
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/$/, "");
  if (path.endsWith("/chat/completions")) {
    return url.toString();
  }
  if (path.endsWith("/v1")) {
    url.pathname = `${path}/chat/completions`;
    return url.toString();
  }
  if (!path || path === "/") {
    url.pathname = "/v1/chat/completions";
    return url.toString();
  }
  url.pathname = `${path}/v1/chat/completions`;
  return url.toString();
}

function sanitizeAssistantText(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const withoutThink = trimmed
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();

  const cleaned = withoutThink
    .replace(/^\s*assistant\s*:\s*/i, "")
    .trim();

  return cleaned || null;
}

function extractToolCall(raw: string): { name: string; arguments: Record<string, unknown> } | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as {
      type?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    };
    if (parsed.type !== "tool_call") return null;
    if (typeof parsed.name !== "string" || !parsed.name.trim()) return null;
    return {
      name: parsed.name.trim(),
      arguments: isRecord(parsed.arguments) ? parsed.arguments : {}
    };
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? raw.trim();
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return candidate.slice(first, last + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
