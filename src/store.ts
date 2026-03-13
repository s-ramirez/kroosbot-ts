export type AdapterKind = "discord" | "imessage";
export type ChatKind = "direct" | "group" | "channel";

export class SessionKey {
  constructor(private readonly value: string) {}

  static direct(adapter: AdapterKind, peerId: string): SessionKey {
    return new SessionKey(`${adapter}:direct:${normalize(peerId)}`);
  }

  static group(adapter: AdapterKind, conversationId: string): SessionKey {
    return new SessionKey(`${adapter}:group:${normalize(conversationId)}`);
  }

  static channel(adapter: AdapterKind, conversationId: string, threadId?: string): SessionKey {
    const base = `${adapter}:channel:${normalize(conversationId)}`;
    return new SessionKey(threadId ? `${base}:thread:${normalize(threadId)}` : base);
  }

  toString(): string {
    return this.value;
  }
}

export type DeliveryTarget = {
  adapter: AdapterKind;
  address: string;
  threadId?: string;
};

export type InboundMessage = {
  adapter: AdapterKind;
  accountId?: string;
  chatKind: ChatKind;
  messageId: string;
  sessionKey: SessionKey;
  conversationId: string;
  threadId?: string;
  deliveryTarget: DeliveryTarget;
  senderId: string;
  senderName?: string;
  text: string;
  timestampMs?: number;
};

export type OutboundMessage = {
  text: string;
};

export type ChatTurn = {
  role: "user" | "assistant" | "system";
  text: string;
};

export type ChatHistory = {
  turns: ChatTurn[];
};

type SessionOrigin = {
  adapter: AdapterKind;
  chatKind: ChatKind;
  conversationLabel?: string;
  senderId: string;
  senderName?: string;
  conversationId: string;
  threadId?: string;
};

type SessionState = {
  key: SessionKey;
  origin: SessionOrigin;
  lastDelivery: DeliveryTarget;
  history: ChatHistory;
};

export class IdentityMap {
  private readonly aliasesToPerson = new Map<string, string>();

  insertAlias(alias: string, canonicalPerson: string): void {
    this.aliasesToPerson.set(normalize(alias), normalize(canonicalPerson));
  }

  resolveDirectSessionKey(adapter: AdapterKind, senderId: string): SessionKey {
    const alias = `${adapter}:${normalize(senderId)}`;
    const canonical = this.aliasesToPerson.get(alias);
    return canonical ? new SessionKey(`person:${canonical}`) : SessionKey.direct(adapter, senderId);
  }
}

export class ConversationStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly seenIds = new Set<string>();
  private readonly seenQueue: string[] = [];

  constructor(private readonly historyLimit: number) {}

  isDuplicate(dedupeKey: string): boolean {
    return this.seenIds.has(dedupeKey);
  }

  rememberMessageId(dedupeKey: string): void {
    if (this.seenIds.has(dedupeKey)) return;
    this.seenIds.add(dedupeKey);
    this.seenQueue.push(dedupeKey);
    while (this.seenQueue.length > 1024) {
      const evicted = this.seenQueue.shift();
      if (evicted) this.seenIds.delete(evicted);
    }
  }

  historyFor(sessionKey: SessionKey): ChatHistory {
    return this.sessions.get(sessionKey.toString())?.history ?? { turns: [] };
  }

  appendUserMessage(message: InboundMessage): void {
    this.upsertSession(message);
    this.appendTurn(message.sessionKey, { role: "user", text: message.text });
  }

  appendAssistantMessage(sessionKey: SessionKey, text: string): void {
    this.appendTurn(sessionKey, { role: "assistant", text });
  }

  static dedupeKey(message: InboundMessage): string {
    return `${message.adapter}:${normalize(message.messageId)}`;
  }

  private upsertSession(message: InboundMessage): void {
    const key = message.sessionKey.toString();
    const existing = this.sessions.get(key);
    const next: SessionState = {
      key: message.sessionKey,
      origin: {
        adapter: message.adapter,
        chatKind: message.chatKind,
        conversationLabel: message.senderName,
        senderId: message.senderId,
        senderName: message.senderName,
        conversationId: message.conversationId,
        threadId: message.threadId
      },
      lastDelivery: message.deliveryTarget,
      history: existing?.history ?? { turns: [] }
    };
    this.sessions.set(key, next);
  }

  private appendTurn(sessionKey: SessionKey, turn: ChatTurn): void {
    const key = sessionKey.toString();
    const session = this.sessions.get(key);
    if (!session) return;
    session.history.turns.push(turn);
    if (session.history.turns.length > this.historyLimit) {
      session.history.turns.splice(0, session.history.turns.length - this.historyLimit);
    }
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
