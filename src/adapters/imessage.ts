import type { Express, Request, Response } from "express";
import type { AppConfig } from "../config.js";
import {
  type DeliveryTarget,
  type InboundMessage,
  type OutboundMessage,
  SessionKey
} from "../store.js";

export class IMessageAdapter {
  private readonly cfg: AppConfig["adapters"]["imessage"];

  constructor(config: AppConfig["adapters"]["imessage"]) {
    this.cfg = config;
  }

  get webhookPath(): string {
    return this.cfg.webhookPath;
  }

  async ping(): Promise<void> {
    if (!this.cfg.enabled) return;
    const response = await fetch(this.apiUrl("/api/v1/ping"));
    if (!response.ok) {
      throw new Error(`imessage ping failed (${response.status}): ${await response.text()}`);
    }
  }

  registerWebhook(app: Express, onInbound: (message: InboundMessage) => Promise<void>): void {
    app.post(this.cfg.webhookPath, async (req: Request, res: Response) => {
      try {
        if (!this.authorize(req)) {
          res.status(401).json({ ok: false, error: "invalid webhook password" });
          return;
        }

        const message = this.normalizeInbound(req.body as Record<string, unknown>);
        if (!message) {
          res.json({ ok: true, ignored: true });
          return;
        }

        await onInbound(message);
        res.json({ ok: true });
      } catch (error) {
        console.error("imessage webhook handler error", error);
        res.status(500).json({ ok: false, error: String(error) });
      }
    });
  }

  async sendText(message: InboundMessage, outbound: OutboundMessage): Promise<void> {
    const target = parseIMessageDeliveryTarget(message.deliveryTarget);
    if (this.cfg.sendTyping && target.kind === "chat_guid") {
      await this.setTyping(target.chatGuid, true).catch(() => undefined);
    }

    if (target.kind === "chat_guid") {
      await this.postJson("/api/v1/message/text", {
        chatGuid: target.chatGuid,
        tempGuid: crypto.randomUUID(),
        message: outbound.text
      });
    } else if (target.kind === "chat_identifier") {
      const chatGuid = await this.resolveChatGuid({
        kind: "chat_identifier",
        chatIdentifier: target.chatIdentifier
      });
      if (!chatGuid) {
        throw new Error(`Unable to resolve chatGuid for chat identifier: ${target.chatIdentifier}`);
      }
      await this.postJson("/api/v1/message/text", {
        chatGuid,
        tempGuid: crypto.randomUUID(),
        message: outbound.text
      });
    } else {
      await this.postJson("/api/v1/chat/new", {
        addresses: [target.address],
        service: target.service === "auto" ? undefined : target.service,
        message: outbound.text,
        tempGuid: `temp-${crypto.randomUUID()}`
      });
    }

    if (this.cfg.sendTyping && target.kind === "chat_guid") {
      await this.setTyping(target.chatGuid, false).catch(() => undefined);
    }
    if (this.cfg.markAsRead && target.kind === "chat_guid") {
      await this.request("POST", `/api/v1/chat/${encodeURIComponent(target.chatGuid)}/read`);
    }
  }

  async sendDirectText(
    address: string,
    text: string,
    options?: { service?: IMessageService }
  ): Promise<void> {
    const normalized = normalizeHandle(address);
    if (!normalized) {
      throw new Error("direct iMessage target is empty");
    }
    await this.postJson("/api/v1/chat/new", {
      addresses: [normalized],
      service: options?.service && options.service !== "auto" ? options.service : undefined,
      message: text,
      tempGuid: `temp-${crypto.randomUUID()}`
    });
  }

  async listChatParticipants(params: {
    chatGuid?: string;
    chatIdentifier?: string;
  }): Promise<string[]> {
    const chat = await this.findChatRecord(params);
    if (!chat) return [];
    return extractParticipantAddresses(chat).map(normalizeHandle).filter(Boolean);
  }

  private authorize(req: Request): boolean {
    const token =
      String(req.query.password ?? req.query.guid ?? req.header("x-password") ?? req.header("x-guid") ?? req.header("x-bluebubbles-guid") ?? "");
    return token === this.cfg.password;
  }

  private normalizeInbound(payload: Record<string, unknown>): InboundMessage | null {
    const root = payload;
    const event = stringAt(root, ["event", "eventType", "type"]) ?? "";
    if (event && !["new-message", "message", "incoming-message"].includes(event)) {
      return null;
    }

    const message = objectAt(root, ["message", "data"]) ?? root;
    if (boolAt(message, ["isFromMe", "is_from_me"])) return null;

    const text = (stringAt(message, ["text", "body", "message"]) ?? "").trim();
    if (!text) return null;

    const messageId = stringAt(message, ["guid", "messageGuid", "message_guid", "id"]);
    const senderId = normalizeHandle(
      stringAt(message, ["senderId", "sender", "from"]) ??
        nestedStringAt(message, "handle", "address") ??
        nestedStringAt(message, "sender", "address") ??
        ""
    );
    if (!messageId || !senderId) return null;

    if (this.cfg.allowedSenders.length > 0) {
      const allowed = this.cfg.allowedSenders.some(
        (s) => normalizeHandle(s) === senderId
      );
      if (!allowed) return null;
    }

    const senderName =
      nestedStringAt(message, "handle", "displayName") ??
      nestedStringAt(message, "sender", "displayName") ??
      stringAt(message, ["senderName", "displayName"]);
    const chatGuid =
      stringAt(message, ["chatGuid", "chat_guid"]) ??
      nestedStringAt(message, "chat", "guid") ??
      firstArrayNestedString(message, "chats", "guid");
    const chatIdentifier = stringAt(message, ["chatIdentifier", "chat_identifier"]);
    const isGroup = resolveIsGroup(chatGuid, boolAt(message, ["isGroup", "is_group"]));
    const conversationId = chatGuid ?? chatIdentifier ?? senderId;

    return {
      adapter: "imessage",
      chatKind: isGroup ? "group" : "direct",
      messageId,
      sessionKey: isGroup
        ? SessionKey.group("imessage", conversationId)
        : SessionKey.direct("imessage", senderId),
      conversationId,
      deliveryTarget: chatGuid
        ? { adapter: "imessage", address: `chat_guid:${chatGuid}` }
        : chatIdentifier
          ? { adapter: "imessage", address: `chat_identifier:${chatIdentifier}` }
          : { adapter: "imessage", address: `handle:imessage:${senderId}` },
      senderId,
      senderName: senderName ?? undefined,
      text
    };
  }

  private async setTyping(chatGuid: string, enabled: boolean): Promise<void> {
    const method = enabled ? "POST" : "DELETE";
    await this.request(method, `/api/v1/chat/${encodeURIComponent(chatGuid)}/typing`);
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<void> {
    await this.request("POST", path, body);
  }

  private async resolveChatGuid(
    target:
      | { kind: "chat_guid"; chatGuid: string }
      | { kind: "chat_identifier"; chatIdentifier: string }
      | { kind: "handle"; address: string; service: IMessageService }
  ): Promise<string | null> {
    if (target.kind === "chat_guid") {
      return target.chatGuid.trim() || null;
    }
    const chat = await this.findChatRecord(
      target.kind === "chat_identifier"
        ? { chatIdentifier: target.chatIdentifier }
        : { handle: target.address }
    );
    return extractChatGuid(chat) ?? null;
  }

  private async findChatRecord(params: {
    chatGuid?: string;
    chatIdentifier?: string;
    handle?: string;
  }): Promise<Record<string, unknown> | null> {
    const chats = await this.queryChats();
    const normalizedHandleTarget = params.handle ? normalizeHandle(params.handle) : null;
    for (const chat of chats) {
      const chatGuid = extractChatGuid(chat);
      const chatIdentifier = extractChatIdentifier(chat, chatGuid);
      if (params.chatGuid?.trim() && chatGuid === params.chatGuid.trim()) {
        return chat;
      }
      if (params.chatIdentifier?.trim() && chatIdentifier === params.chatIdentifier.trim()) {
        return chat;
      }
      if (normalizedHandleTarget) {
        const participants = extractParticipantAddresses(chat).map(normalizeHandle);
        if (participants.length === 1 && participants[0] === normalizedHandleTarget) {
          return chat;
        }
      }
    }
    return null;
  }

  private async queryChats(): Promise<Array<Record<string, unknown>>> {
    const response = await fetch(this.apiUrl("/api/v1/chat/query"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        limit: 500,
        offset: 0,
        with: ["participants"]
      })
    });
    if (!response.ok) {
      throw new Error(`imessage chat query failed (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const data = payload && Array.isArray(payload.data) ? payload.data : [];
    return data.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.apiUrl(path), {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      throw new Error(`imessage request failed (${response.status}) on ${path}: ${await response.text()}`);
    }
  }

  private apiUrl(path: string): string {
    const url = new URL(this.cfg.serverUrl);
    url.pathname = path;
    url.searchParams.set("password", this.cfg.password);
    return url.toString();
  }
}

type IMessageService = "imessage" | "sms" | "auto";

function parseIMessageDeliveryTarget(target: DeliveryTarget):
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; address: string; service: IMessageService } {
  if (target.adapter !== "imessage") {
    throw new Error("delivery target adapter mismatch: expected imessage");
  }
  if (target.address.startsWith("chat_guid:")) {
    return { kind: "chat_guid", chatGuid: target.address.slice("chat_guid:".length) };
  }
  if (target.address.startsWith("chat_identifier:")) {
    return { kind: "chat_identifier", chatIdentifier: target.address.slice("chat_identifier:".length) };
  }
  if (target.address.startsWith("handle:")) {
    const raw = target.address.slice("handle:".length);
    const parts = raw.split(":");
    if (parts.length >= 2) {
      const service = parts[0]?.trim().toLowerCase() as IMessageService;
      const address = parts.slice(1).join(":").trim();
      return {
        kind: "handle",
        service: service === "sms" || service === "auto" ? service : "imessage",
        address
      };
    }
    return { kind: "handle", service: "imessage", address: raw.trim() };
  }
  throw new Error(`unsupported imessage delivery target: ${target.address}`);
}

function stringAt(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function objectAt(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function nestedStringAt(record: Record<string, unknown>, key: string, nestedKey: string): string | null {
  const nested = record[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const value = (nested as Record<string, unknown>)[nestedKey];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boolAt(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => record[key] === true);
}

function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

function firstArrayNestedString(record: Record<string, unknown>, arrayKey: string, nestedKey: string): string | null {
  const arr = record[arrayKey];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return null;
  const value = first[nestedKey];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveIsGroup(chatGuid: string | null, explicit: boolean): boolean {
  if (chatGuid?.includes(";+;")) return true;
  if (chatGuid?.includes(";-;")) return false;
  return explicit;
}

function extractChatGuid(chat: Record<string, unknown> | null): string | null {
  if (!chat) return null;
  const candidates = [chat.chatGuid, chat.guid, chat.chat_guid];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractChatIdentifier(chat: Record<string, unknown>, chatGuid?: string | null): string | null {
  const candidates = [chat.chatIdentifier, chat.chat_identifier, chat.identifier];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (!chatGuid) return null;
  const parts = chatGuid.split(";");
  const identifier = parts[2]?.trim();
  return identifier || null;
}

function extractParticipantAddresses(chat: Record<string, unknown>): string[] {
  const raw =
    (Array.isArray(chat.participants) ? chat.participants : null) ??
    (Array.isArray(chat.handles) ? chat.handles : null) ??
    (Array.isArray(chat.participantHandles) ? chat.participantHandles : null);
  if (!raw) return [];
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      result.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const candidate =
        (typeof record.address === "string" && record.address) ||
        (typeof record.handle === "string" && record.handle) ||
        (typeof record.id === "string" && record.id) ||
        (typeof record.identifier === "string" && record.identifier);
      if (typeof candidate === "string" && candidate.trim()) {
        result.push(candidate.trim());
      }
    }
  }
  return result;
}
