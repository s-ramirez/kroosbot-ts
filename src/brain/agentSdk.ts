import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { MemoryManager } from "../memory/manager.js";
import type { SkillDefinition } from "../skills/types.js";
import type { ChatHistory, InboundMessage, OutboundMessage } from "../store.js";
import { loadWorkspaceContext } from "../workspace/context.js";
import { buildSystemPrompt, compactHistoryWithoutLatestMessage } from "./prompt.js";
import type { Brain, ToolTraceEvent } from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";

export class AgentSdkBrain implements Brain {
  private readonly cfg: AppConfig["brain"]["agentSdk"];
  private readonly workspaceDir: string;
  private readonly systemPrompt: string;
  private readonly historyWindow: number;
  private readonly toolConfig: AppConfig["brain"]["tools"];
  private readonly tools?: ToolRegistry;
  // Updated before each query so MCP tool handlers can access the current session
  private currentSessionKey = "";

  constructor(
    config: AppConfig["brain"],
    workspaceDir: string,
    private readonly memoryManager?: MemoryManager,
    tools?: ToolRegistry,
    private readonly skills: SkillDefinition[] = [],
    private readonly onToolTrace?: (event: ToolTraceEvent) => void
  ) {
    this.cfg = config.agentSdk;
    this.workspaceDir = workspaceDir;
    this.systemPrompt = config.systemPrompt;
    this.historyWindow = config.historyWindow;
    this.toolConfig = config.tools;
    this.tools = tools;
  }

  async reply(message: InboundMessage, history: ChatHistory): Promise<OutboundMessage | null> {
    const text = message.text.trim();
    if (!text) return null;

    this.currentSessionKey = message.sessionKey.toString();

    const memoryResults = await this.memoryManager?.search(text);
    const workspaceContext = await loadWorkspaceContext(this.workspaceDir);
    const systemPromptText = buildSystemPrompt(
      this.systemPrompt,
      message,
      memoryResults ?? [],
      [], // tools are handled via MCP, not injected as text
      this.skills,
      workspaceContext
    );

    const historyMessages = compactHistoryWithoutLatestMessage(history, message, this.historyWindow);
    const historyPrefix = historyMessages.length > 0
      ? historyMessages
          .filter((t) => t.role === "user" || t.role === "assistant")
          .map((t) => `${t.role}: ${t.content}`)
          .join("\n") + "\n\n"
      : "";

    const prompt = historyPrefix + text;

    console.info("sending agent-sdk query", {
      session: message.sessionKey.toString(),
      model: this.cfg.model || "(default)",
      memoryResults: memoryResults?.length ?? 0
    });

    // Create a fresh MCP server per query — the SDK binds a transport on connect,
    // so reusing the same instance across calls causes "Already connected" errors.
    const mcpServer = this.buildMcpServer(this.tools, this.toolConfig);

    const options: Parameters<typeof query>[0]["options"] = {
      systemPrompt: systemPromptText,
      maxTurns: mcpServer ? this.toolConfig.maxSteps * 3 : 1,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
      ...(mcpServer ? { mcpServers: { "kroosbot-tools": mcpServer } } : {})
    };

    let result = "";
    for await (const msg of query({ prompt, options })) {
      if (msg.type === "result") {
        console.info("agent-sdk query completed", {
          session: message.sessionKey.toString(),
          subtype: msg.subtype,
          turns: msg.num_turns,
          hasResult: "result" in msg ? Boolean((msg as { result: string }).result) : false
        });
        if (msg.subtype === "success") {
          result = msg.result;
        } else {
          console.warn("agent-sdk query ended with error", {
            session: message.sessionKey.toString(),
            msg
          });
          result = describeAgentSdkFailure(msg.subtype);
        }
      }
    }

    return result.trim() ? { text: result.trim() } : null;
  }

  private buildMcpServer(
    tools: ToolRegistry | undefined,
    toolConfig: AppConfig["brain"]["tools"]
  ): McpSdkServerConfigWithInstance | null {
    if (!toolConfig.enabled || !tools) return null;

    const definitions = tools.definitions();
    if (definitions.length === 0) return null;

    const mcpTools = definitions.map((def) => {
      const schemaShape = Object.fromEntries(
        def.parameters.map((param) => {
          const field = z.string().describe(param.description);
          return [param.name, param.required ? field : field.optional()];
        })
      );

      return tool(def.name, def.description, schemaShape, async (args) => {
        const sessionKey = this.currentSessionKey;
        console.info("executing tool call", {
          session: sessionKey,
          tool: def.name,
          arguments: args
        });

        const result = await tools.execute(def.name, args as Record<string, unknown>, { sessionKey });

        this.onToolTrace?.({
          sessionKey,
          step: 0,
          toolName: def.name,
          arguments: args as Record<string, unknown>,
          ok: result.ok,
          content: result.content,
          requiresApproval: result.requiresApproval,
          approvalId: result.approvalId
        });

        return {
          content: [{ type: "text" as const, text: result.content }],
          isError: !result.ok
        };
      });
    });

    return createSdkMcpServer({ name: "kroosbot-tools", tools: mcpTools });
  }
}

function describeAgentSdkFailure(subtype: string): string {
  switch (subtype) {
    case "error_max_turns":
      return "I hit my tool-step limit before I could finish that. Please try again with a shorter request, or ask me to continue from the last step.";
    case "error_max_budget_usd":
      return "I stopped because the model budget for that request was exhausted.";
    case "error_max_structured_output_retries":
      return "I couldn't finish because the model kept failing to produce a valid structured response.";
    case "error_during_execution":
    default:
      return "I ran into an internal error while working on that request.";
  }
}
