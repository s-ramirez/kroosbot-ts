import type { AppConfig } from "../config.js";
import { AgentSdkBrain } from "../brain/agentSdk.js";
import { OpenAiCompatibleBrain } from "../brain/openaiCompatible.js";
import type { Brain, ToolTraceEvent } from "../brain/types.js";
import { MemoryManager } from "../memory/manager.js";
import type { SkillDefinition } from "../skills/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { AgentStore } from "./store.js";
import type { SubagentDefinition } from "./types.js";

export class SubagentManager {
  private readonly store: AgentStore;
  private readonly brainCache = new Map<string, Brain>();
  private readonly memoryCache = new Map<string, MemoryManager>();
  private readonly sessionAgentMap = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private defaultBrain: Brain,
    private readonly defaultMemory: MemoryManager,
    private defaultTools: ToolRegistry,
    private readonly defaultSkills: SkillDefinition[],
    private readonly onToolTrace?: (event: ToolTraceEvent) => void
  ) {
    this.store = new AgentStore(config.agents.rootDir);
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

  brainFor(sessionKey: string): Brain {
    const agentId = this.sessionAgentMap.get(sessionKey);
    if (!agentId) return this.defaultBrain;

    const cached = this.brainCache.get(agentId);
    if (cached) return cached;

    // Agent was deleted or not found — fall back to default
    return this.defaultBrain;
  }

  memoryFor(sessionKey: string): MemoryManager {
    const agentId = this.sessionAgentMap.get(sessionKey);
    if (!agentId) return this.defaultMemory;
    return this.memoryCache.get(agentId) ?? this.defaultMemory;
  }

  activeAgentId(sessionKey: string): string | undefined {
    return this.sessionAgentMap.get(sessionKey);
  }

  switchAgent(sessionKey: string, agentId: string | null): void {
    if (!agentId) {
      this.sessionAgentMap.delete(sessionKey);
    } else {
      this.sessionAgentMap.set(sessionKey, agentId);
    }
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
    if (existing) throw new Error(`Agent "${id}" already exists`);

    const def: SubagentDefinition = {
      id,
      name: params.name,
      brainMode: params.brainMode ?? this.config.brain.mode === "agent-sdk" ? "agent-sdk" : "openai-compatible",
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

    await this.store.save(def);

    if (params.personality) {
      await this.store.saveSoul(id, params.personality);
    }

    // Build and cache the brain + memory
    await this.ensureBrain(def);

    return def;
  }

  async deleteAgent(id: string): Promise<void> {
    this.brainCache.delete(id);
    this.memoryCache.delete(id);
    // Remove any session bindings pointing to this agent
    for (const [session, agentId] of this.sessionAgentMap) {
      if (agentId === id) this.sessionAgentMap.delete(session);
    }
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

    // Filter tools if allowedTools is specified
    let tools: ToolRegistry = this.defaultTools;
    if (def.allowedTools.length > 0) {
      const allTools = this.defaultTools.definitions();
      const allowed = new Set(def.allowedTools);
      const filteredToolDefs = allTools.filter((t) => allowed.has(t.name));
      // We need to create a filtered registry — use the full registry but filter at brain level
      // For now, just pass the full registry; tool filtering can be refined later
      void filteredToolDefs;
      tools = this.defaultTools;
    }

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

  /** Re-hydrate brains for all persisted agents (call after initialize) */
  async loadAll(): Promise<void> {
    const agents = await this.store.list();
    for (const def of agents) {
      await this.ensureBrain(def);
    }
  }
}
