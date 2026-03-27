# Tools

Tools are registered in a `ToolRegistry` (`src/tools/registry.ts`) and exposed to the brain. Each tool has a `ToolDefinition` (name, description, parameters) and an `execute(args, context)` method.

## Tool Approval

Tools can have `approvalMode: "always"`, which means execution creates a `PendingToolApproval` instead of running immediately. The user must run `/approve <id>` or `/deny <id>` to complete the action. High-impact actions like `memory_write` and proactive `send_message` use this.

## Built-in Tools

### Memory Tools (`src/tools/memoryTools.ts`)

| Tool | Description |
|------|-------------|
| `memory_search` | Keyword search against MEMORY.md + memory/*.md files |
| `memory_write` | Append a durable note to memory (requires approval) |

### Session Tools (`src/tools/sessionTools.ts`)

| Tool | Description |
|------|-------------|
| `list_sessions` | List recent chat sessions and their routing metadata |
| `session_history` | Show recent turns from a target session |
| `send_message` | Send a proactive assistant message into a session (requires approval) |

### Coding Tools (`src/tools/codingTools.ts`)

| Tool | Description |
|------|-------------|
| `list_files` | List directory contents under workspaceDir |
| `search_files` | Grep-like text search across workspace files |
| `read_file` | Read file contents (clamped to size limits) |

### Plan Tools (`src/tools/planTools.ts`)

| Tool | Description |
|------|-------------|
| `get_current_plan` | Show the current session plan |
| `update_current_plan` | Create or refine a structured plan |
| `block_current_plan_on_user` | Mark plan as blocked with manual steps needed |
| `resume_current_plan` | Unblock plan after user completes manual steps |
| `clear_current_plan` | Clear the current plan |
| `delegate_current_plan` | Create a background job from the current plan |

### Job Tools (`src/tools/jobTools.ts`)

| Tool | Description |
|------|-------------|
| `delegate_job` | Start a background job in an isolated worktree |
| `list_jobs` | List recent jobs and their statuses |
| `get_job_status` | Get detailed state and progress for a job |
| `get_job_log` | Tail the worker log for a job |
| `review_job` | Run a review brain on the job's diff + checks |
| `approve_job` | Accept a reviewed job's changes |
| `reject_job` | Discard changes and reset the job |
| `retry_job` | Restart a job from clean state |

### Agent Tools (`src/tools/agentTools.ts`)

| Tool | Description |
|------|-------------|
| `create_agent` | Create a new subagent with name, model, and optional personality |
| `switch_agent` | Switch the current session to a different agent (or `"default"`) |
| `list_agents` | List all available agents |

### Skill Tools (`src/tools/skillTools.ts`)

| Tool | Description |
|------|-------------|
| `list_skills` | List workspace skills with enabled/disabled status |
| `create_skill_scaffold` | Scaffold a new skill package (skill.json, SKILL.md, handler.js) |
| `set_skill_enabled` | Toggle a skill's enabled state |
| `reload_assistant_runtime` | Reload skills and brain from disk |

## Adding New Tools

1. Create a factory function in `src/tools/` that returns `Tool[]`
2. Register tools via `ToolRegistry.createBuiltIn()` in `src/tools/piTools.ts`
3. Tools are automatically exposed to both brain modes (MCP for agent-sdk, text descriptions for openai-compatible)

## Operator Surface

The app also exposes lightweight session controls outside the model loop:

- `/sessions`
- `/session history <session-key> [limit]`
- `/session send <session-key> <text>`
- `GET /sessions`
- `GET /sessions/:sessionKey`
- `GET /sessions/:sessionKey/history?limit=20`
- `POST /sessions/:sessionKey/messages` with `{ "text": "..." }`
