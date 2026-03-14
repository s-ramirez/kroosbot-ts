# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev        # run with hot reload (primary development mode)
bun run build      # type-check and compile via tsc
bun run evals      # run eval suite (evals/tool-decisions.json by default)
bun run evals ./evals/some-suite.json  # run a specific eval file
```

There are no automated tests beyond the eval harness. The build (`bun run build`) is the type-check. Always verify it passes after changes.

## Configuration

Copy `config.example.json` → `config.json` before running. Config is loaded and validated with Zod in `src/config.ts`. The `KROOSBOT_CONFIG` env var overrides the config file path.

Key `brain.mode` values:
- `"agent-sdk"` — uses `@anthropic-ai/claude-agent-sdk`, authenticates via Claude Code OAuth (`claude login`, no API key needed)
- `"openai-compatible"` — raw HTTP to any OpenAI-compatible endpoint (llama.cpp, LM Studio, etc.)
- `"echo"` — no LLM, echoes input back (testing only)

## Architecture

### Message flow

```
Adapter (Discord / iMessage)
  → app.ts handleInbound()
    → dedup + history append
    → slash command handlers (memory, tools, jobs)
    → brain.reply()
  → sendReply() via adapter
```

`SessionKey` and `DeliveryTarget` are intentionally separate: a session can span adapters (e.g. same person via Discord and iMessage is one session). `ConversationStore` tracks history keyed by `SessionKey`.

### Brain interface (`src/brain/types.ts`)

All brains implement `Brain.reply(message, history) → OutboundMessage | null`. The active brain is chosen by `brain.mode` in config and wired in `app.ts`.

- **`AgentSdkBrain`** — wraps `query()` from `@anthropic-ai/claude-agent-sdk`. Flattens conversation history into the prompt prefix. Converts `ToolRegistry` tools into an in-process MCP server via `createSdkMcpServer` + `tool()`. Uses a mutable `currentSessionKey` field (set before each query) so MCP tool handlers can access the right session.
- **`OpenAiCompatibleBrain`** — manual tool loop: tools are described as text in the system prompt, the model emits `{"type":"tool_call",...}` JSON, which is parsed and executed in a loop.
- **`EchoBrain`** — mirrors input, supports `/ping` and `/history`.

### Tools (`src/tools/`)

`ToolRegistry` holds named `Tool` instances. Tools have a `ToolDefinition` (name, description, parameters typed as `"string"`, optional `approvalMode`). `memory_write` requires user approval — the registry creates a `PendingToolApproval` and the user runs `/approve <id>` or `/deny <id>` to complete it.

Built-in tools are created in `src/tools/piTools.ts` and registered via `ToolRegistry.createBuiltIn()`. File tools are scoped to `app.workspaceDir`.

### Memory (`src/memory/`)

File-backed. Notes live in `MEMORY.md` and `memory/*.md` (categories like `preference`, `decision`, `todo`). `MemoryManager.search()` does keyword scoring against parsed blocks and is called before every brain reply to inject relevant context into the system prompt.

### Skills (`src/skills/`)

`SkillDefinition` is a named block of instructions injected into the system prompt. Currently only `job_orchestration` exists, which teaches the brain how to use background job tools. Skills are created in `src/skills/registry.ts` and passed through to all brain constructors.

### Background jobs (`src/jobs/`)

Jobs run in isolated Git worktrees on `codex/job-<id>` branches using the `pi` CLI as a subprocess. `JobSupervisor` manages lifecycle (create, start, cancel, retry, review). Job state is stored as JSON files under `jobs.rootDir`. The review flow runs a second brain instance against the diff + check results to produce an `approve | request_changes | reject` decision.

### System prompt (`src/brain/prompt.ts`)

`buildSystemPrompt()` assembles: base prompt + output rules + memory policy + runtime context (adapter/session/sender) + memory results + tool descriptions (for `openai-compatible` mode) + skill instructions. For `agent-sdk` mode, tools are omitted from the prompt since they're exposed natively via MCP.

### Adapters

- **Discord** (`src/adapters/discord.ts`) — uses `discord.js`, optional `requireMention` and `allowedChannelIds` filters
- **iMessage** (`src/adapters/imessage.ts`) — webhook receiver for BlueBubbles-compatible server, sends via REST
