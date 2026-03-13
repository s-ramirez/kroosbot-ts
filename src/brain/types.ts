import type { ChatHistory, InboundMessage, OutboundMessage } from "../store.js";

export interface Brain {
  reply(message: InboundMessage, history: ChatHistory): Promise<OutboundMessage | null>;
}
