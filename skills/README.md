# Skills

Workspace skills live in this directory.

Each skill package is a folder with:

- `skill.json` — manifest
- `SKILL.md` — human-editable instructions that are injected into the assistant prompt
- optional `handler.js` — code-backed behavior that can register tools

Folders that start with `_` are ignored by the loader. Use that for templates and drafts.

## Manifest

Example:

```json
{
  "name": "imposter-game",
  "description": "Start and manage an imposter game in iMessage group chats.",
  "enabled": true,
  "entry": "handler.js"
}
```

## Handler

A code-backed skill exports `registerSkill(context)`.

It can return:

- `instructions`: extra prompt guidance
- `description`: optional runtime override for the skill description
- `tools`: tool objects with the same shape as built-in tools

The loader imports `handler.js` directly from the workspace, so skill handlers can be generated and edited without changing the core app.

## Built-in skill lifecycle tools

Kroosbot now has built-in tools for basic workspace skill management:

- `list_skills` — inspect workspace skills on disk and see which ones are currently loaded
- `create_skill_scaffold` — create a new `skills/<name>/` package
- `set_skill_enabled` — flip a skill's manifest `enabled` flag
- `reload_assistant_runtime` — reload skills and tools from disk without restarting the whole process

That gives the current system a minimal vertical slice for capability expansion:

1. scaffold a skill
2. edit or enable it
3. reload the runtime
4. use the new capability

For bigger capability requests, Kroosbot should use the plan tools first, especially when the work depends on manual user setup like package installs, model downloads, or external services.
