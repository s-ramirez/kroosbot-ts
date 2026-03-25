import fs from "node:fs/promises";
import path from "node:path";
import type { SubagentConfig } from "../config.js";
import type { SubagentDefinition } from "./types.js";

export class AgentStore {
  constructor(private readonly rootDir: string) {}

  async initialize(seed: SubagentConfig[]): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    for (const entry of seed) {
      const existing = await this.get(entry.id);
      if (!existing) {
        await this.save({
          id: entry.id,
          name: entry.name,
          brainMode: entry.brainMode,
          model: entry.model,
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
          temperature: entry.temperature,
          maxOutputTokens: entry.maxOutputTokens,
          requestTimeoutMs: entry.requestTimeoutMs,
          systemPrompt: entry.systemPrompt,
          allowedTools: entry.allowedTools,
          skills: entry.skills,
          createdAt: new Date().toISOString(),
          createdBy: "config-seed"
        });
      }
    }
  }

  async list(): Promise<SubagentDefinition[]> {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const agents: SubagentDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const def = await this.get(entry.name);
      if (def) agents.push(def);
    }
    return agents;
  }

  async get(id: string): Promise<SubagentDefinition | null> {
    const filePath = this.agentJsonPath(id);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as SubagentDefinition;
    } catch {
      return null;
    }
  }

  async save(def: SubagentDefinition): Promise<void> {
    const dir = this.agentDir(def.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.agentJsonPath(def.id), JSON.stringify(def, null, 2), "utf8");
  }

  async delete(id: string): Promise<void> {
    const dir = this.agentDir(id);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async saveSoul(id: string, content: string): Promise<void> {
    const dir = this.agentDir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SOUL.md"), content, "utf8");
  }

  async loadSoul(id: string): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.agentDir(id), "SOUL.md"), "utf8");
      const trimmed = raw.trim();
      return trimmed || undefined;
    } catch {
      return undefined;
    }
  }

  agentDir(id: string): string {
    return path.join(this.rootDir, id);
  }

  private agentJsonPath(id: string): string {
    return path.join(this.rootDir, id, "agent.json");
  }
}
