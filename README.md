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

- `src/store.ts`: normalized message/session model and in-memory store
- `src/memory/`: file-backed memory manager and search
- `src/brain/`: brain implementations and prompt helpers
- `src/adapters/`: Discord and iMessage adapters
- `src/app.ts`: top-level orchestration and dispatch
- `src/config.ts`: config loading and validation

## Memory

This version keeps memory deliberately simple:

- durable notes live in `MEMORY.md` and `memory/*.md`
- the brain searches those files before answering
- `/remember ...` appends a durable note into a dated file under `memory/`
- `/remember preference: ...`, `/remember todo: ...`, and similar prefixes create more structured entries
- `/memory search ...` lets you inspect exactly what memory retrieval sees
- narrow auto-memory captures only high-confidence preferences and decisions from user messages

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
