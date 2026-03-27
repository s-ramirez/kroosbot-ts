import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { SessionSnapshot } from "../store.js";

type ConversationLogRecord = {
  sessionKey: string;
  updatedAt: string;
  historyLimit: number;
  origin: SessionSnapshot["origin"];
  lastDelivery: SessionSnapshot["lastDelivery"];
  turns: SessionSnapshot["history"]["turns"];
};

export class ConversationLogger {
  readonly enabled: boolean;
  private readonly rootDir: string;
  private readonly historyLimit: number;

  constructor(config: AppConfig["conversations"]) {
    this.enabled = config.enabled;
    this.rootDir = path.resolve(config.rootDir);
    this.historyLimit = config.historyLimit;
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async writeSession(session: SessionSnapshot | null): Promise<void> {
    if (!this.enabled || !session) return;

    const payload: ConversationLogRecord = {
      sessionKey: session.key.toString(),
      updatedAt: new Date().toISOString(),
      historyLimit: this.historyLimit,
      origin: session.origin,
      lastDelivery: session.lastDelivery,
      turns: session.history.turns.slice(-this.historyLimit)
    };

    await fs.writeFile(
      this.sessionFilePath(session.key.toString()),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8"
    );
  }

  private sessionFilePath(sessionKey: string): string {
    return path.join(this.rootDir, `${sanitizeFileName(sessionKey)}.json`);
  }
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "session";
}
