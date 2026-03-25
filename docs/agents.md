# Subagent System

The agent system allows multiple AI personalities, each with their own brain configuration, memory, allowed tools, and skills.

**Files:** `src/agents/manager.ts`, `src/agents/store.ts`, `src/agents/types.ts`

## Concepts

A `SubagentDefinition` includes:
- `id`, `name` — identity
- `brainMode`, `model`, `baseUrl`, `apiKey`, `temperature` — brain configuration
- `systemPrompt` — personality/instructions (also loadable from `SOUL.md`)
- `allowedTools` — tool whitelist (empty = all tools)
- `skills` — skill whitelist
- `createdAt` — timestamp

## Agent Resolution

When a message arrives, the `SubagentManager` resolves which agent to use:

1. **Explicit binding** — session was switched to an agent via `switch_agent`
2. **Default agent** — `agents.defaultAgentId` in config
3. **Sole agent fallback** — if only one agent exists, use it
4. **No agent** — falls back to the default brain + memory

Each resolved agent gets its own `Brain` instance and `MemoryManager`, cached by agent ID.

## Creating Agents

Agents can be created in two ways:

### Via Config (Seed Agents)

```json
{
  "agents": {
    "enabled": true,
    "rootDir": "./kroosbot-data/agents",
    "seed": [
      {
        "id": "coder",
        "name": "Coder",
        "brainMode": "agent-sdk",
        "model": "claude-sonnet-4-20250514",
        "systemPrompt": "You are a focused coding assistant."
      }
    ]
  }
}
```

### Via Tool (Runtime)

The `create_agent` tool allows creating agents from within a conversation:
```
create_agent(name: "Researcher", model: "claude-sonnet-4-20250514", personality: "...")
```

## Switching Agents

Use `switch_agent(agent_id)` to bind the current session to a specific agent. Use `switch_agent("default")` to return to the default brain.

Session-to-agent bindings are persisted to disk so they survive restarts.

## File Structure

```
{agents.rootDir}/{agentId}/
├── agent.json    # SubagentDefinition
└── SOUL.md       # Optional personality file
```
