import type { ChatHistory, InboundMessage } from "../store.js";
import type { MemorySearchResult } from "../memory/types.js";
import type { ToolDefinition } from "../tools/types.js";

export function buildSystemPrompt(
  systemPrompt: string,
  message: InboundMessage,
  memoryResults: MemorySearchResult[] = [],
  tools: ToolDefinition[] = []
): string {
  const base =
    systemPrompt.trim() ||
    "You are Kroosbot. Keep replies short and practical.";
  const outputRules = [
    "Reply to the user with final answer text only.",
    "Do not include chain-of-thought, hidden reasoning, analysis sections, or thinking process.",
    "Do not emit <think> tags, <thinking> tags, or any similar reasoning wrapper."
  ].join("\n");
  const memoryPolicy = [
    "Use memory for durable information, not everything in the conversation.",
    "If the user shares a lasting preference, decision, personal fact, or important long-term project detail, you may call memory_write.",
    "Before calling memory_write, normalize the note into a short durable fact instead of copying the whole message.",
    "Do not store temporary chatter, one-off requests, or speculative claims as memory.",
    "Because memory_write requires approval, ask for it by making the tool call when the information is worth saving."
  ].join("\n");
  const memoryBlock =
    memoryResults.length > 0
      ? `\n\nRelevant memory:\n${memoryResults
          .map((entry) => {
            const suffix =
              entry.endLine > entry.startLine ? `-L${entry.endLine}` : "";
            return `- ${entry.path}#L${entry.startLine}${suffix}: ${entry.snippet}`;
          })
          .join("\n")}`
      : "";
  const toolBlock =
    tools.length > 0
      ? `\n\nTools:\n${tools
          .map((tool) => {
            const params = tool.parameters
              .map((param) => `${param.name}${param.required ? "*" : ""}: ${param.description}`)
              .join("; ");
            const approval = (tool.approvalMode ?? "none") === "always"
              ? " Requires user approval before execution."
              : "";
            return `- ${tool.name}: ${tool.description}${params ? ` Parameters: ${params}` : ""}${approval}`;
          })
          .join("\n")}\n\nTool calling rules:\nIf you need a tool, reply with JSON only in this exact shape:\n{"type":"tool_call","name":"tool_name","arguments":{"key":"value"}}\nDo not add markdown fences or any extra text when making a tool call.\nIf you already have enough information, reply with the final answer directly.`
      : "";
  return `${base}\n\nOutput rules:\n${outputRules}\n\nMemory policy:\n${memoryPolicy}\n\nRuntime context:\n${buildContextPreamble(message)}${memoryBlock}${toolBlock}`;
}

export function buildContextPreamble(message: InboundMessage): string {
  return [
    `Adapter: ${message.adapter}`,
    `Chat kind: ${message.chatKind}`,
    `Session: ${message.sessionKey.toString()}`,
    `Sender: ${message.senderName ?? message.senderId}`,
    `Conversation: ${message.conversationId}`
  ].join("\n");
}

export function compactHistoryWithoutLatestMessage(
  history: ChatHistory,
  message: InboundMessage,
  maxTurns: number
): Array<{ role: string; content: string }> {
  const keep = Math.max(maxTurns, 1);
  const recent = history.turns.slice(-(keep + 1));
  const filtered =
    recent.length > 0 &&
    recent[recent.length - 1]?.role === "user" &&
    recent[recent.length - 1]?.text.trim() === message.text.trim()
      ? recent.slice(0, -1)
      : recent;

  return filtered.slice(-keep).map((turn) => ({
    role: turn.role,
    content: turn.text
  }));
}
