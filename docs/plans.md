# Planning System

The planning system tracks structured implementation plans per session, providing a bridge between conversation and job delegation.

**File:** `src/plans/manager.ts`

## Plan Structure

A `SessionPlan` contains:

| Field | Purpose |
|-------|---------|
| `title` | Short name for the plan |
| `summary` | What the plan accomplishes |
| `checklist` | Step-by-step implementation items |
| `acceptanceCriteria` | How to verify the work is done |
| `manualSteps` | Steps the user must perform (host setup, installs) |
| `blockedOnUser` | Whether the plan is waiting on the user |
| `blockedReason` | Why it's blocked |
| `allowedScope` | What changes are in scope |
| `outOfScope` | What to explicitly avoid |
| `checkCommands` | Commands to verify the work (e.g., `bun run build`) |
| `reviewInstructions` | Guidance for the review brain |
| `workspaceDir` | Target workspace |
| `provider`, `model` | Override brain config for delegation |

## Workflow

1. Brain calls `update_current_plan` to create/refine the plan iteratively
2. If host setup is needed, `block_current_plan_on_user` marks it blocked with manual steps
3. User completes manual steps, then `resume_current_plan` unblocks
4. When ready (title + summary + criteria + checklist all set, not blocked), `delegate_current_plan` creates a background job from the plan

## Plan Updates

`update()` uses a merge strategy:
- Scalar fields (title, summary) are replaced
- List fields (checklist, acceptanceCriteria) are appended
- This allows iterative refinement across multiple tool calls
