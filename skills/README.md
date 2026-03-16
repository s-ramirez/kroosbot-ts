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
