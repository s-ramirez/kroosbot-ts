import type { Brain } from "./types.js";
import type { ChatHistory, InboundMessage, OutboundMessage } from "../store.js";

export class EchoBrain implements Brain {
  constructor(
    private readonly systemPrompt: string,
    private readonly prefix: string
  ) {}

  async reply(message: InboundMessage, history: ChatHistory): Promise<OutboundMessage | null> {
    const text = message.text.trim();
    if (!text) return null;

    let reply: string;
    if (text.toLowerCase() === "/ping") {
      reply = "pong";
    } else if (text.toLowerCase() === "/history") {
      const items = history.turns
        .slice(-5)
        .reverse()
        .map((turn) => `${turn.role}: ${turn.text}`)
        .join("\n");
      reply = items
        ? `Session: ${message.sessionKey.toString()}\nRecent history:\n${items}`
        : "No history yet.";
    } else if (this.systemPrompt.trim()) {
      reply = `${this.prefix} ${text}\n\nContext: ${this.systemPrompt}`;
    } else {
      reply = `${this.prefix} ${text}`;
    }

    return { text: reply };
  }
}
