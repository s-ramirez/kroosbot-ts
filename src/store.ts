import { RuntimeStore } from "./runtime-store/store.js";

export type AdapterKind = "discord" | "imessage";
export type SessionAdapterKind = AdapterKind | "system";
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
  adapter: SessionAdapterKind;
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

export type SessionSnapshot = {
  key: SessionKey;
  origin: {
    adapter: SessionAdapterKind;
    chatKind: ChatKind;
    conversationLabel?: string;
    senderId: string;
    senderName?: string;
    conversationId: string;
    threadId?: string;
  };
  lastDelivery: DeliveryTarget;
  history: ChatHistory;
};

export type SessionSummary = {
  key: SessionKey;
  origin: {
    adapter: SessionAdapterKind;
    chatKind: ChatKind;
    conversationLabel?: string;
    senderId: string;
    senderName?: string;
    conversationId: string;
    threadId?: string;
  };
  lastDelivery: DeliveryTarget;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
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
  constructor(
    private readonly runtime: RuntimeStore,
    private readonly historyLimit: number
  ) {}

  isDuplicate(dedupeKey: string): boolean {
    const [adapter, ...rest] = dedupeKey.split(":");
    const externalMessageId = rest.join(":");
    if (!adapter || !externalMessageId) return false;
    return this.runtime.hasInboundMessage(adapter, externalMessageId);
  }

  rememberMessageId(dedupeKey: string): void {
    void dedupeKey;
  }

  historyFor(sessionKey: SessionKey): ChatHistory {
    return this.runtime.historyForSession(sessionKey, this.historyLimit);
  }

  sessionFor(sessionKey: SessionKey | string): SessionSnapshot | null {
    const key = typeof sessionKey === "string" ? sessionKey : sessionKey.toString();
    return this.runtime.sessionFor(key);
  }

  appendUserMessage(message: InboundMessage): void {
    this.runtime.appendInboundMessage(message);
  }

  appendAssistantMessage(sessionKey: SessionKey, text: string): void {
    this.runtime.appendAssistantMessage(sessionKey, text);
  }

  static dedupeKey(message: InboundMessage): string {
    return `${message.adapter}:${normalize(message.messageId)}`;
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
