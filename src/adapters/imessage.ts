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
    let target = parseIMessageDeliveryTarget(message.deliveryTarget);

    // Webhook payloads often arrive with an empty chats array, so we only have
    // the handle. Construct the chat GUID directly (iMessage;-;+1234567890) so
    // we can send via /message/text instead of /chat/new.
    if (target.kind === "handle") {
      target = { kind: "chat", value: `iMessage;-;${target.value}` };
    }

    if (this.cfg.sendTyping && target.kind === "chat") {
      await this.setTyping(target.value, true).catch(() => undefined);
    }

    if (target.kind === "chat") {
      await this.postJson("/api/v1/message/text", {
        chatGuid: target.value,
        tempGuid: crypto.randomUUID(),
        message: outbound.text
      });
    } else {
      await this.postJson("/api/v1/chat/new", {
        addresses: [target.value],
        message: outbound.text,
        tempGuid: `temp-${crypto.randomUUID()}`
      });
    }

    if (this.cfg.sendTyping && target.kind === "chat") {
      await this.setTyping(target.value, false).catch(() => undefined);
    }
    if (this.cfg.markAsRead && target.kind === "chat") {
      await this.request("POST", `/api/v1/chat/${encodeURIComponent(target.value)}/read`);
    }
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
        ? { adapter: "imessage", address: `chat:${chatGuid}` }
        : { adapter: "imessage", address: `handle:${senderId}` },
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

function parseIMessageDeliveryTarget(target: DeliveryTarget): { kind: "chat" | "handle"; value: string } {
  if (target.adapter !== "imessage") {
    throw new Error("delivery target adapter mismatch: expected imessage");
  }
  if (target.address.startsWith("chat:")) {
    return { kind: "chat", value: target.address.slice("chat:".length) };
  }
  if (target.address.startsWith("handle:")) {
    return { kind: "handle", value: target.address.slice("handle:".length) };
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
