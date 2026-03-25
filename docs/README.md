# Kroosbot-TS Documentation

## Quick Start

```bash
cp config.example.json config.json   # configure your settings
bun install                          # install dependencies
bun run dev                          # start with hot reload
```

See [Configuration](./configuration.md) for the full config reference.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | High-level design, message flow, directory map, key decisions |
| [Configuration](./configuration.md) | Full config schema reference |
| [Brains](./brains.md) | Brain implementations: AgentSdk, OpenAI-compatible, Echo |
| [Adapters](./adapters.md) | Discord and iMessage adapter setup |
| [Tools](./tools.md) | All built-in tools: memory, coding, plans, jobs, agents, skills |
| [Memory](./memory.md) | File-backed memory system with keyword search |
| [Jobs](./jobs.md) | Background job execution in isolated git worktrees |
| [Agents](./agents.md) | Multi-agent system with per-agent brains and personalities |
| [Skills](./skills.md) | Core skills and workspace skill authoring |
| [Plans](./plans.md) | Session-scoped structured planning |
| [Evals](./evals.md) | Tool-decision eval harness |
| [Capability Expansion Roadmap](./capability-expansion-roadmap.md) | Roadmap for self-expanding capabilities |

## Development

```bash
bun run dev        # run with hot reload
bun run build      # type-check via tsc (this is the test suite)
bun run evals      # run eval suite
```

There are no automated tests beyond the eval harness. `bun run build` is the type-check — always verify it passes after changes.
