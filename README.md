# Kroosbot TS

Small TypeScript version of `kroosbot`, built to stay close to the architecture we validated in Rust:

- normalized inbound messages across adapters
- `SessionKey` separate from `DeliveryTarget`
- one `Brain` interface
- Discord and iMessage as adapters
- OpenAI-compatible brain for `llama.cpp`-style backends
- file-backed memory recall inspired by OpenClaw's `MEMORY.md` + `memory/*.md` model
- a small built-in tool layer for memory and read-only workspace inspection

## Setup

1. Copy `config.example.json` to `config.json`.
2. Run `bun install`.
3. Start your `llama.cpp` server.
4. If using Discord, enable the adapter and add your bot token.
5. If using iMessage, point your BlueBubbles-compatible webhook to:

```text
http://127.0.0.1:8788/imessage/webhook?password=change-me
```

6. Run:

```bash
bun run dev
```

## Structure

- `src/store.ts`: normalized message/session model and conversation facade over the runtime store
- `src/memory/`: file-backed memory manager and search
- `src/brain/`: brain implementations and prompt helpers
- `src/adapters/`: Discord and iMessage adapters
- `src/app.ts`: top-level orchestration and dispatch
- `src/config.ts`: config loading and validation
- `src/runtime-store/`: SQLite-backed runtime persistence for sessions, messages, plans, approvals, tasks, and job metadata
- `SOUL.md`: workspace-level personality, boundaries, and initiative guidance
- `HEARTBEAT.md`: workspace-level heartbeat intent
- `skills/`: workspace skill packages with manifests, prompt files, and optional code handlers

## Memory

This version keeps memory deliberately simple:

- durable notes live in `MEMORY.md` and `memory/*.md`
- the brain searches those files before answering
- `/remember ...` appends a durable note into a dated file under `memory/`
- `/remember preference: ...`, `/remember todo: ...`, and similar prefixes create more structured entries
- `/memory search ...` lets you inspect exactly what memory retrieval sees
- narrow auto-memory captures only high-confidence preferences and decisions from user messages

## Soul

The main assistant now reads `SOUL.md` from the configured workspace on each turn.

Use it for:

- personality and tone
- behavioral principles
- initiative boundaries
- continuity rules

This keeps the assistant's "self" editable in the workspace, similar in spirit to OpenClaw.

`brain.systemPrompt` still exists, but it should stay small and stable. `SOUL.md` is now the main living personality layer.

## Skills

Workspace skills now live under `skills/`.

Each skill package can include:

- `skill.json`
- `SKILL.md`
- optional `handler.js`

`SKILL.md` contributes prompt guidance. `handler.js` can register code-backed tools.

This gives the app a path toward agent-authored skills without requiring changes to the core runtime.

See `skills/README.md` for the package format, and `skills/_template-imposter-game/` for a starter template.

## Tools

This version now includes a small `pi-tools`-style built-in tool framework.

Current tools:

- `memory_search`
- `memory_write`
- `list_files`
- `search_files`
- `read_file`

The tools are intentionally narrow:

- memory tools can search and append durable notes
- file tools are read-only
- file tools are scoped to `app.workspaceDir`
- tools are composed through a small builder in `src/tools/piTools.ts`

Debug commands:

- `/tools` lists the registered tools
- `/tool trace` shows recent tool activity for the current session
- `/tool trace 10` shows a larger recent window
- `/approvals` lists pending tool approvals for the current session
- `/approve <id>` approves a pending tool request
- `/deny <id>` denies a pending tool request

Approval behavior:

- tools can be marked as requiring approval before execution
- `memory_write` is the first approval-gated tool
- the model will receive a pending approval result and should ask you to approve or deny it

Memory behavior:

- obvious preferences and decisions can still be auto-captured by app-side rules
- the model is now also instructed to propose `memory_write` for durable facts worth keeping
- `memory_write` stays approval-gated, so the model can suggest a memory without silently storing it

## Evals

You can run a small evaluation suite against the current model and prompt setup:

```bash
bun run evals
```

Or point at a specific suite file:

```bash
bun run evals ./evals/tool-decisions.json
```

The eval harness runs the real brain and tool loop, then reports:

- which tools were called
- whether expected tool decisions were made
- the final answer
- which cases passed or failed

The first suite lives in `evals/tool-decisions.json` and now covers:

- durable memory-write decisions
- cases that should not be stored as memory
- repo inspection via `search_files`
- direct file reads via `read_file`
- memory recall answers
- simple chat cases where no tool should be used

It is meant to be a starter benchmark for comparing local models, not just a smoke test.

## Background Jobs

This version now includes a first pass at detached background coding jobs backed by `pi`.

The main assistant can now build a structured plan with you during normal conversation and delegate that plan to a background worker, instead of relying only on slash commands.

Primary commands:

- `/delegate help`
- `/delegate <json>`
- `/jobs`
- `/job status <id>`
- `/job log <id>`
- `/job cancel <id>`
- `/job review <id>`
- `/job approve <id>`
- `/job reject <id>`
- `/job retry <id>`

Jobs are stored under `jobs.rootDir` and run in isolated Git worktrees on `codex/job-<id>` branches.

By default, job workers launch `pi` under a PTY so coding-agent file edits are more reliable.

For local OpenAI-compatible backends like LM Studio, configure `pi` with a custom provider in `~/.pi/agent/models.json` and point jobs at that provider instead of using the built-in `openai` provider.

Example:

```json
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "api": "openai-completions",
      "apiKey": "lmstudio",
      "models": [
        { "id": "deepseek/deepseek-r1-0528-qwen3-8b" }
      ]
    }
  }
}
```

Then set `jobs.defaultProvider` to `lmstudio` and `jobs.defaultModel` to the matching model id.

## Planning Flow

The main assistant now has a small planning layer for background coding work.

In normal conversation, it can:

- build a structured plan draft for the current chat session
- refine that draft as you clarify scope and success criteria
- delegate the current plan to a background worker when it is ready
- review the worker's result and continue automatically if changes are needed

The planning tools available to the assistant are:

- `get_current_plan`
- `update_current_plan`
- `clear_current_plan`
- `delegate_current_plan`

The old `/delegate` and `/job ...` commands still exist as a fallback, but the preferred path is now to talk through the plan naturally and let the assistant use these tools itself.

## Initiative

Kroosbot now uses the scheduled task engine for initiative, so heartbeat behavior is just an internal task instead of a separate timer system.

When `initiative.enabled` is on, the app installs an internal scheduled task that checks background jobs and can:

- automatically review jobs that reach `ready_for_review`
- send a proactive message back to the original chat when a job is blocked
- continue the review loop without waiting for a manual `/job review ...`

The current initiative config is:

- `initiative.enabled`
- `initiative.heartbeatIntervalMs`
- `initiative.cron`
- `initiative.autoReviewReadyJobs`
- `initiative.notifyBlockedJobs`

If `initiative.cron` is set, Kroosbot uses that cron expression for scheduling. Otherwise it falls back to `initiative.heartbeatIntervalMs`.

This is intentionally narrow. Initiative does not invent brand new work on its own yet; it only reacts to ongoing jobs and review state.

The operator task surface is also available:

- `/tasks`
- `/task add <json>`
- `/task pause <id>`
- `/task resume <id>`
- `/task delete <id>`
- `/task run <id>`
