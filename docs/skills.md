# Skills System

Skills are named blocks of instructions (and optional tools) injected into the system prompt. They teach the brain how to handle specific domains.

**Files:** `src/skills/types.ts`, `src/skills/registry.ts`, `src/skills/loader.ts`

## Core Skills

Created in `src/skills/registry.ts`, enabled automatically when their corresponding feature is enabled in config:

### `job_orchestration`
Teaches the brain to use plan and job tools: build structured plans, delegate work to background jobs, review results, and handle continuation.

### `capability_expansion`
Guides feature requests through classification: workspace skill, core feature, adapter extension, or external integration. See [capability-expansion-roadmap.md](./capability-expansion-roadmap.md).

### `agent_orchestration`
Teaches the brain to create and switch agents, describes the agent resolution model.

## Workspace Skills

User-authored skills loaded from `workspace/skills/{skillName}/`.

### Structure

```
workspace/skills/my-skill/
├── skill.json      # Manifest: name, description, enabled, entry
├── SKILL.md        # Prompt instructions (injected into system prompt)
└── handler.js      # Optional: exports tools and lifecycle hooks
```

### Manifest (`skill.json`)

```json
{
  "name": "my-skill",
  "description": "What this skill does",
  "enabled": true,
  "entry": "handler.js"
}
```

### Handler

If an `entry` file is specified, it's dynamically imported and instantiated with a `SkillHandlerContext` providing access to config, memory, jobs, plans, and the workspace directory. Handlers can return additional tools that get merged into the `ToolRegistry`.

## Managing Skills

Use the built-in skill tools:
- `list_skills` — see all workspace skills and their status
- `create_skill_scaffold` — generate a new skill package
- `set_skill_enabled` — toggle enabled/disabled
- `reload_assistant_runtime` — reload skills + brain from disk
