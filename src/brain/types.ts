import type { ChatHistory, InboundMessage, OutboundMessage } from "../store.js";

export interface Brain {
  reply(message: InboundMessage, history: ChatHistory): Promise<OutboundMessage | null>;
}

export type ToolTraceEvent = {
  sessionKey: string;
  step: number;
  toolName: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  content: string;
  requiresApproval?: boolean;
  approvalId?: string;
};
