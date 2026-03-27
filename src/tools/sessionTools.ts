import type { RuntimeStore } from "../runtime-store/store.js";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { clampText, optionalString, requiredString } from "./shared.js";

export function createSessionTools(
  runtime: RuntimeStore,
  options?: {
    sendMessage?: (params: { sessionKey: string; text: string; sourceSessionKey: string }) => Promise<void>;
  }
): Tool[] {
  return [
    new ListSessionsTool(runtime),
    new SessionHistoryTool(runtime),
    new SendMessageTool(runtime, options?.sendMessage)
  ];
}

class ListSessionsTool implements Tool {
  readonly definition = {
    name: "list_sessions",
    description: "List recent chat sessions and their routing metadata.",
    parameters: [
      {
        name: "limit",
        type: "string" as const,
        description: "Optional max number of sessions to return. Defaults to 10."
      }
    ]
  };

  constructor(private readonly runtime: RuntimeStore) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const limit = parseOptionalLimit(args.limit, 10, 50);
    const sessions = this.runtime.listSessions(limit);
    if (sessions.length === 0) {
      return { ok: true, content: "No sessions found." };
    }
    return {
      ok: true,
      content: sessions
        .map((session, index) => [
          `${index + 1}. ${session.key.toString()} [${session.origin.adapter}/${session.origin.chatKind}]`,
          `status: ${session.status}`,
          `sender: ${(session.origin.senderName ?? session.origin.senderId) || "(unknown)"}`,
          `conversation: ${session.origin.conversationId}`,
          `delivery: ${session.lastDelivery.adapter}:${session.lastDelivery.address}`,
          `last_message_at: ${session.lastMessageAt ?? "(none)"}`
        ].join("\n"))
        .join("\n\n")
    };
  }
}

class SessionHistoryTool implements Tool {
  readonly definition = {
    name: "session_history",
    description: "Show recent conversation turns for a chat session.",
    parameters: [
      {
        name: "session_key",
        type: "string" as const,
        description: "Optional target session key. Defaults to the current chat session."
      },
      {
        name: "limit",
        type: "string" as const,
        description: "Optional max number of turns to return. Defaults to 12."
      }
    ]
  };

  constructor(private readonly runtime: RuntimeStore) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const sessionKey = optionalString(args.session_key) ?? context.sessionKey;
    const session = this.runtime.sessionFor(sessionKey);
    if (!session) {
      return { ok: false, content: `Session not found: ${sessionKey}` };
    }
    const limit = parseOptionalLimit(args.limit, 12, 50);
    const history = this.runtime.historyForSessionKey(sessionKey, limit);
    if (history.turns.length === 0) {
      return { ok: true, content: `No history found for ${sessionKey}.` };
    }
    return {
      ok: true,
      content: [
        `Session: ${sessionKey}`,
        `Turns: ${history.turns.length}`,
        "",
        ...history.turns.map((turn, index) => `${index + 1}. ${turn.role}: ${clampText(turn.text, 500)}`)
      ].join("\n")
    };
  }
}

class SendMessageTool implements Tool {
  readonly definition = {
    name: "send_message",
    description: "Send a proactive assistant message into a chat session using its last known delivery target.",
    approvalMode: "always" as const,
    parameters: [
      {
        name: "text",
        type: "string" as const,
        description: "Message text to send.",
        required: true
      },
      {
        name: "session_key",
        type: "string" as const,
        description: "Optional target session key. Defaults to the current chat session."
      }
    ]
  };

  constructor(
    private readonly runtime: RuntimeStore,
    private readonly sendMessage?: (params: { sessionKey: string; text: string; sourceSessionKey: string }) => Promise<void>
  ) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const text = requiredString(args.text, "text");
    const sessionKey = optionalString(args.session_key) ?? context.sessionKey;
    const session = this.runtime.sessionFor(sessionKey);
    if (!session) {
      return { ok: false, content: `Session not found: ${sessionKey}` };
    }
    if (session.lastDelivery.adapter === "system") {
      return { ok: false, content: `Session ${sessionKey} does not have a deliverable chat target.` };
    }
    if (!this.sendMessage) {
      return { ok: false, content: "Message sending is not available in this runtime." };
    }
    await this.sendMessage({
      sessionKey,
      text,
      sourceSessionKey: context.sessionKey
    });
    return {
      ok: true,
      content: `Sent a message to ${sessionKey}.`
    };
  }
}

function parseOptionalLimit(value: unknown, fallback: number, max: number): number {
  const raw = optionalString(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(parsed, max);
}
