import type { SubagentManager } from "../agents/manager.js";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { optionalString, requiredString } from "./shared.js";

export function createAgentTools(agents: SubagentManager): Tool[] {
  return [
    new CreateAgentTool(agents),
    new SwitchAgentTool(agents),
    new ListAgentsTool(agents)
  ];
}

class CreateAgentTool implements Tool {
  readonly definition = {
    name: "create_agent",
    description: "Create a new named agent with its own brain, memory, and optional personality.",
    parameters: [
      { name: "name", type: "string" as const, description: "Name for the new agent.", required: true },
      { name: "model", type: "string" as const, description: "Model identifier e.g. claude-opus-4-6.", required: true },
      { name: "brain_mode", type: "string" as const, description: "agent-sdk or openai-compatible." },
      { name: "personality", type: "string" as const, description: "Personality description for the agent SOUL." }
    ]
  };

  constructor(private readonly agents: SubagentManager) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const name = requiredString(args.name, "name");
    const model = requiredString(args.model, "model");
    const brainModeRaw = optionalString(args.brain_mode);
    const personality = optionalString(args.personality);

    let brainMode: "agent-sdk" | "openai-compatible" | undefined;
    if (brainModeRaw) {
      if (brainModeRaw !== "agent-sdk" && brainModeRaw !== "openai-compatible") {
        return { ok: false, content: `Invalid brain_mode "${brainModeRaw}". Must be "agent-sdk" or "openai-compatible".` };
      }
      brainMode = brainModeRaw;
    }

    try {
      const agent = await this.agents.createAgent({ name, model, brainMode, personality });
      return { ok: true, content: `Created agent "${agent.name}" with id "${agent.id}" using model ${agent.model}.` };
    } catch (err) {
      return { ok: false, content: `Failed to create agent: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

class SwitchAgentTool implements Tool {
  readonly definition = {
    name: "switch_agent",
    description: "Switch the current session to a different agent, or back to the default.",
    parameters: [
      { name: "agent_id", type: "string" as const, description: "Agent id to switch to, or 'default' to switch back.", required: true }
    ]
  };

  constructor(private readonly agents: SubagentManager) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const agentId = requiredString(args.agent_id, "agent_id");
    const sessionKey = context.sessionKey;

    if (agentId === "default") {
      this.agents.switchAgent(sessionKey, null);
      return { ok: true, content: "Switched back to the default agent." };
    }

    const agent = await this.agents.getAgent(agentId);
    if (!agent) {
      return { ok: false, content: `Agent "${agentId}" not found.` };
    }

    this.agents.switchAgent(sessionKey, agentId);
    return { ok: true, content: `Switched session to agent "${agent.name}" (${agent.id}).` };
  }
}

class ListAgentsTool implements Tool {
  readonly definition = {
    name: "list_agents",
    description: "List all available agents.",
    parameters: []
  };

  constructor(private readonly agents: SubagentManager) {}

  async execute(_args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const agents = await this.agents.listAgents();
    if (agents.length === 0) {
      return { ok: true, content: "No agents configured." };
    }
    const lines = agents.map((a) => `- ${a.id}: ${a.name} (model: ${a.model}, mode: ${a.brainMode})`);
    return { ok: true, content: lines.join("\n") };
  }
}
