# Architecture Overview

Kroosbot-TS is a multi-adapter chatbot framework with configurable AI brains, file-backed memory, background job execution, and a multi-agent system.

## High-Level Message Flow

```
Adapter (Discord / iMessage)
  → KroosbotApp.handleInbound()
    → ConversationStore: dedup + history append
    → Slash command handling (/tools, /approve, /deny, etc.)
    → SubagentManager: resolve brain + memory for session
    → MemoryManager.search() → inject relevant context
    → Brain.reply(message, history) → OutboundMessage
  → Adapter.sendReply()
```

## Core Concepts

### SessionKey vs DeliveryTarget

These are intentionally separate. A `SessionKey` identifies a conversation session (e.g., `discord:direct:user123`) while a `DeliveryTarget` specifies where to send a reply (adapter + address + optional thread). A single person across Discord and iMessage can share one session.

### Brain Interface

All brains implement `Brain.reply(message, history) → OutboundMessage | null`. The active brain is selected by `brain.mode` in config and wired up in `app.ts`. See [brains.md](./brains.md) for details on each implementation.

### Tool Loop

Tools are executed differently depending on the brain:

- **AgentSdkBrain**: Tools are exposed natively via an in-process MCP server. The SDK handles the tool loop internally.
- **OpenAiCompatibleBrain**: Tools are described as text in the system prompt. The model emits JSON tool calls (`{"type":"tool_call",...}`), which the brain parses and executes in a manual loop.

### System Prompt Assembly

`buildSystemPrompt()` in `src/brain/prompt.ts` assembles the prompt from:

1. Base prompt + output rules + memory policy
2. Runtime context (adapter, session, sender info)
3. Memory search results (relevant notes)
4. Tool descriptions (for `openai-compatible` mode only)
5. Skill instructions (all active skills)
6. SOUL.md override (workspace personality, if present)

## Directory Map

```
src/
├── index.ts              # Entry point, initializes KroosbotApp
├── app.ts                # KroosbotApp: orchestrator, inbound handling, heartbeat
├── store.ts              # SessionKey, DeliveryTarget, ConversationStore
├── config.ts             # Zod schema, config loading + validation
├── brain/                # Brain implementations + prompt building
├── adapters/             # Discord, iMessage adapters
├── tools/                # Tool definitions, registry, built-in tools
├── memory/               # File-backed memory with keyword search
├── jobs/                 # Background job system (supervisor, worker, git)
├── agents/               # Subagent manager + store
├── skills/               # Skill definitions, core skills, workspace loader
├── plans/                # In-memory session plan tracking
├── evals/                # Eval harness for tool-decision testing
└── workspace/            # SOUL.md / HEARTBEAT.md context loading
```

## Key Design Decisions

- **File-backed persistence** for memory, jobs, and agents — no database required.
- **Detached worker processes** for background jobs — each runs in an isolated git worktree.
- **Tool approval flow** — safety-critical tools (like `memory_write`) require explicit user approval via `/approve`.
- **Initiative heartbeat** — optional loop that reconciles jobs, auto-reviews completed work, and notifies on blocked jobs.
- **SOUL.md layering** — workspace personality file overrides the base system prompt, giving each workspace its own character.
