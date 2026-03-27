import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { AgentSdkBrain } from "../brain/agentSdk.js";
import { OpenAiCompatibleBrain } from "../brain/openaiCompatible.js";
import type { Brain, ToolTraceEvent } from "../brain/types.js";
import { MemoryManager } from "../memory/manager.js";
import type { RuntimeStore } from "../runtime-store/store.js";
import type { SkillDefinition } from "../skills/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentStore } from "./store.js";
import type { SubagentDefinition } from "./types.js";

export class SubagentManager {
  private readonly store: AgentStore;
  private readonly brainCache = new Map<string, Brain>();
  private readonly memoryCache = new Map<string, MemoryManager>();

  constructor(
    private readonly config: AppConfig,
    runtime: RuntimeStore,
    private defaultBrain: Brain,
    private readonly defaultMemory: MemoryManager,
    private defaultTools: ToolRegistry,
    private readonly defaultSkills: SkillDefinition[],
    private readonly onToolTrace?: (event: ToolTraceEvent) => void
  ) {
    this.store = new AgentStore(config.agents.rootDir, runtime);
  }

  /** Set the real default brain and tools after they are constructed (resolves init ordering). */
  setDefaults(brain: Brain, tools: ToolRegistry): void {
    this.defaultBrain = brain;
    this.defaultTools = tools;
  }

  async initialize(): Promise<void> {
    if (!this.config.agents.enabled) return;
    await this.store.initialize(this.config.agents.seed);
  }

  /** The main brain always handles conversations. Sub-agents are background workers only. */
  brainFor(_sessionKey: string): Brain {
    return this.defaultBrain;
  }

  /** The main memory always handles conversations. Sub-agents have separate memory for jobs. */
  memoryFor(_sessionKey: string): MemoryManager {
    return this.defaultMemory;
  }

  async createAgent(
    params: {
      name: string;
      model: string;
      brainMode?: "agent-sdk" | "openai-compatible";
      personality?: string;
      baseUrl?: string;
      apiKey?: string;
      temperature?: number;
      maxOutputTokens?: number;
      requestTimeoutMs?: number;
      systemPrompt?: string;
      allowedTools?: string[];
      skills?: string[];
    },
    createdBy?: string
  ): Promise<SubagentDefinition> {
    const id = params.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    if (!id) throw new Error("Agent name produces an empty id");

    const existing = await this.store.get(id);

    const def: SubagentDefinition = existing
      ? {
          ...existing,
          name: params.name,
          model: params.model,
          ...(params.brainMode !== undefined ? { brainMode: params.brainMode } : {}),
          ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
          ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
          ...(params.requestTimeoutMs !== undefined ? { requestTimeoutMs: params.requestTimeoutMs } : {}),
          ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
          ...(params.allowedTools !== undefined ? { allowedTools: params.allowedTools } : {}),
          ...(params.skills !== undefined ? { skills: params.skills } : {})
        }
      : {
          id,
          name: params.name,
          brainMode: params.brainMode ?? (this.config.brain.mode === "agent-sdk" ? "agent-sdk" : "openai-compatible"),
          model: params.model,
          baseUrl: params.baseUrl,
          apiKey: params.apiKey,
          temperature: params.temperature ?? this.config.brain.openAiCompatible.temperature,
          maxOutputTokens: params.maxOutputTokens ?? this.config.brain.openAiCompatible.maxOutputTokens,
          requestTimeoutMs: params.requestTimeoutMs ?? this.config.brain.openAiCompatible.requestTimeoutMs,
          systemPrompt: params.systemPrompt,
          allowedTools: params.allowedTools ?? [],
          skills: params.skills ?? [],
          createdAt: new Date().toISOString(),
          createdBy
        };

    await this.assertPiModelAvailable(def);
    await this.store.save(def);

    if (params.personality) {
      await this.store.saveSoul(id, params.personality);
    }

    // Invalidate cached brain so it rebuilds with new config
    this.brainCache.delete(id);
    this.memoryCache.delete(id);
    await this.ensureBrain(def);

    return def;
  }

  async deleteAgent(id: string): Promise<void> {
    this.brainCache.delete(id);
    this.memoryCache.delete(id);
    await this.store.delete(id);
  }

  async listAgents(): Promise<SubagentDefinition[]> {
    return this.store.list();
  }

  async getAgent(id: string): Promise<SubagentDefinition | null> {
    return this.store.get(id);
  }

  async setSoul(id: string, content: string): Promise<void> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error(`Agent "${id}" not found`);
    await this.store.saveSoul(id, content);
    // Invalidate brain cache so it rebuilds with the new soul
    this.brainCache.delete(id);
    await this.ensureBrain(existing);
  }

  async ensureBrain(def: SubagentDefinition): Promise<Brain> {
    const cached = this.brainCache.get(def.id);
    if (cached) return cached;

    // Create agent-specific memory
    const memoryConfig: AppConfig["memory"] = {
      ...this.config.memory,
      rootDir: `${this.config.agents.rootDir}/${def.id}/memory`
    };
    const memory = new MemoryManager(memoryConfig);
    await memory.initialize();
    this.memoryCache.set(def.id, memory);

    const tools = this.defaultTools;

    // Filter skills if specified
    const skills = def.skills.length > 0
      ? this.defaultSkills.filter((s) => def.skills.includes(s.name))
      : this.defaultSkills;

    // Load soul override
    const soul = await this.store.loadSoul(def.id);

    // Build a synthetic brain config
    const brainConfig: AppConfig["brain"] = {
      ...this.config.brain,
      systemPrompt: def.systemPrompt ?? this.config.brain.systemPrompt,
      openAiCompatible: {
        ...this.config.brain.openAiCompatible,
        model: def.model,
        temperature: def.temperature,
        maxOutputTokens: def.maxOutputTokens,
        requestTimeoutMs: def.requestTimeoutMs,
        ...(def.baseUrl ? { baseUrl: def.baseUrl } : {}),
        ...(def.apiKey ? { apiKey: def.apiKey } : {})
      },
      agentSdk: {
        ...this.config.brain.agentSdk,
        model: def.model
      }
    };

    const brain =
      def.brainMode === "agent-sdk"
        ? new AgentSdkBrain(brainConfig, this.config.app.workspaceDir, memory, tools, skills, this.onToolTrace, soul)
        : new OpenAiCompatibleBrain(brainConfig, this.config.app.workspaceDir, memory, tools, skills, this.onToolTrace, soul);

    this.brainCache.set(def.id, brain);
    return brain;
  }

  /**
   * Translate brain config into pi-compatible job model config.
   * Uses the named agent if provided, otherwise falls back to the main brain config.
   */
  async resolveJobModelConfig(_sessionKey: string, agentId?: string): Promise<{
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
  }> {
    if (agentId) {
      const def = await this.store.get(agentId);
      if (def) {
        await this.assertPiModelAvailable(def);
        const baseUrl = def.baseUrl ?? this.config.brain.openAiCompatible.baseUrl;
        const provider = def.brainMode === "agent-sdk" ? "anthropic" : inferPiProviderFromBaseUrl(baseUrl);
        return {
          provider,
          model: def.model,
          baseUrl,
          apiKey: def.apiKey ?? this.config.brain.openAiCompatible.apiKey
        };
      }
    }

    return this.defaultJobConfig();
  }

  private async assertPiModelAvailable(def: SubagentDefinition): Promise<void> {
    if (def.brainMode === "agent-sdk") return;

    const baseUrl = def.baseUrl ?? this.config.brain.openAiCompatible.baseUrl;
    const provider = inferPiProviderFromBaseUrl(baseUrl);
    if (!baseUrl || provider === "openai") return;

    const registry = await this.loadPiRegistry();
    const providerModels = registry.providers[provider]?.models ?? [];
    const hasModel = providerModels.some((model) => model.id === def.model);
    if (hasModel) return;

    throw new Error(
      `Agent "${def.id}" uses ${provider}/${def.model}, but Pi cannot find that model in ${piRegistryPath()}. ` +
      `Add it under providers.${provider}.models before using this agent for delegated jobs.`
    );
  }

  private async loadPiRegistry(): Promise<PiModelRegistry> {
    const raw = await fs.readFile(piRegistryPath(), "utf8").catch(() => "");
    if (!raw.trim()) {
      return { providers: {} };
    }

    try {
      const parsed = JSON.parse(raw) as PiModelRegistry;
      return parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object"
        ? parsed
        : { providers: {} };
    } catch {
      return { providers: {} };
    }
  }

  private defaultJobConfig(): {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
  } {
    const configuredBaseUrl = this.config.brain.openAiCompatible.baseUrl;
    const inferredProvider = inferPiProviderFromBaseUrl(configuredBaseUrl);
    const provider = this.config.jobs.defaultProvider || inferredProvider;
    const model = this.config.jobs.defaultModel
      || (this.config.brain.mode === "agent-sdk"
        ? this.config.brain.agentSdk.model
        : this.config.brain.openAiCompatible.model);
    const baseUrl = this.config.jobs.defaultProvider === inferredProvider
      || !this.config.jobs.defaultProvider
      ? configuredBaseUrl
      : undefined;
    const apiKey = this.config.brain.openAiCompatible.apiKey;
    return {
      provider,
      model,
      baseUrl,
      apiKey
    };
  }

  /** Derive pi-compatible job config from the main brain settings. */
  private mainBrainJobConfig(): {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
  } {
    return this.defaultJobConfig();
  }

  /** Re-hydrate brains for all persisted agents. */
  async loadAll(): Promise<void> {
    const agents = await this.store.list();
    for (const def of agents) {
      await this.ensureBrain(def);
    }
  }
}

function inferPiProviderFromBaseUrl(baseUrl?: string): string {
  const url = (baseUrl ?? "").toLowerCase();
  if (url.includes("localhost:1234") || url.includes("127.0.0.1:1234")) {
    return "lmstudio";
  }
  if (url.includes("anthropic.com")) {
    return "anthropic";
  }
  if (url.includes("openai.com")) {
    return "openai";
  }
  return "openai";
}

type PiModelRegistry = {
  providers: Record<string, { models?: Array<{ id: string }> }>;
};

function piRegistryPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "models.json");
}
