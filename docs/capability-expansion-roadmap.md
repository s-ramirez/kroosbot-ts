# Capability Expansion Roadmap

This roadmap turns Kroosbot's current "load workspace skills if they already exist" behavior into a more explicit "expand your own capabilities" workflow.

## Goal

When a user asks for a new capability, Kroosbot should be able to:

- collaborate with the user on the idea instead of inventing a catalog
- classify the request as a workspace skill, core feature, adapter extension, or external integration
- choose the right implementation path
- scaffold the needed files or delegate the right coding job
- explain any restart, approval, or install requirements clearly
- stop and ask the user to perform manual host setup when Kroosbot cannot safely do it itself

## Current State

Today Kroosbot can:

- load workspace skills from `skills/*`
- inject skill instructions into the prompt
- register extra tools from skill handlers
- delegate larger coding work as background jobs
- keep a structured implementation plan for the current session

Today Kroosbot cannot reliably:

- discover or manage skills as a first-class concept
- scaffold a new skill package without repo spelunking
- distinguish lightweight skill work from core app changes
- install richer capabilities like local services or attachment delivery in a guided way
- carry manual install requirements through the implementation workflow in a structured way

## Phase 1

Make capability expansion explicit and easy to start.

- Add a core `capability_expansion` skill with guidance for handling "teach yourself a new feature" requests.
- Add built-in tools to inspect workspace skills and scaffold a new skill package.
- Keep skill creation approval-gated because it writes executable workspace files.
- Update delegation guidance so the assistant classifies the request before exploring the repo.
- Record manual user prerequisites explicitly and block delegation while those prerequisites are still pending.

### Phase 1 Deliverables

- `capability_expansion` core skill
- `list_skills` tool
- `create_skill_scaffold` tool
- `set_skill_enabled` tool
- `reload_assistant_runtime` tool
- skill scaffolds compatible with the existing loader (`skill.json`, `SKILL.md`, optional `handler.js`)

### Working Vertical Slice

The current end-to-end workflow is now:

1. inspect current skills with `list_skills`
2. create a new skill package with `create_skill_scaffold`
3. enable or disable it with `set_skill_enabled`
4. activate the latest on-disk state with `reload_assistant_runtime`

This is intentionally small, but it gives Kroosbot a concrete path to expand its prompt-level and tool-backed skill surface from inside the chat loop.

## Phase 1.5

Tighten the human-in-the-loop workflow for capabilities that need host setup.

- Let the assistant store manual install or setup requirements in the current plan.
- Give the assistant an explicit blocked-on-user state instead of relying on implicit stalled plans.
- Let the assistant resume the plan cleanly after the user finishes the setup.
- Refuse to delegate coding work while manual steps are still pending.
- Nudge the assistant to ask the user for host-level installs instead of assuming it can run them.

## Phase 2

Separate extension paths so the assistant chooses the right one earlier.

- Workspace skill: prompt guidance plus optional lightweight tools
- Core tool: new built-in behavior wired into the app
- Adapter extension: channel-specific features like attachments
- External integration: local services, APIs, installers, health checks

## Phase 3

Add runtime primitives for richer capability types.

- attachment sending for iMessage
- long-running background result delivery
- standard integration patterns for local services like ACE-Step
- explicit restart or reload behavior for newly added skills

## Phase 4

Make skill management feel productized.

- enabled/disabled skill status surfaced directly to the assistant
- install/update/remove flows
- optional managed skill metadata
- runtime reload instead of restart-only activation

## Phase 5

Reduce agent drift on expansion tasks.

- tighten prompts so the assistant classifies the request before browsing the repo
- prefer plan and skill tools over generic file listing
- improve failure messages when the request needs unsupported primitives

## Example: ACE-Step Music Generation

This request spans multiple extension types:

- core tool: `generate_music`
- external integration: ACE-Step local API and output management
- adapter extension: sending generated audio back through iMessage
- optional skill guidance: when to use the tool and how to ask clarifying questions

That is why a pure prompt-only skill is not enough for this feature.
