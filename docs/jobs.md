# Background Jobs

The job system runs long-running coding tasks in isolated git worktrees using the `pi` CLI as a subprocess.

## Architecture

```
KroosbotApp
  → JobSupervisor (lifecycle management)
    → JobStore (file-based persistence)
    → JobWorker (detached subprocess)
      → PiJobRunner (spawns pi CLI)
        → Git worktree (isolated branch)
```

**Files:** `src/jobs/supervisor.ts`, `src/jobs/worker.ts`, `src/jobs/store.ts`, `src/jobs/git.ts`, `src/jobs/runtime/pi.ts`

## Job Lifecycle

```
queued → running → ready_for_review → completed
                 → blocked          → (retry) → running
                 → failed           → (retry) → running
         → canceled
         → rejected
```

### Status Values

| Status | Meaning |
|--------|---------|
| `queued` | Created, waiting to start |
| `running` | Worker process active |
| `blocked` | Worker hit an issue needing user input |
| `ready_for_review` | Work complete, awaiting review |
| `completed` | Reviewed and approved |
| `failed` | Worker errored out |
| `rejected` | Review rejected the changes |
| `canceled` | Manually canceled |

## How Jobs Run

1. **`delegate_job`** tool is called with a title, goal, and optional plan
2. `JobSupervisor.createAndStartJob()`:
   - Creates a git worktree on branch `codex/job-<id>` from the current HEAD
   - Persists the job record to `{rootDir}/{jobId}/job.json`
   - Spawns a detached worker process (`node worker.ts --job <id>`)
3. The worker process:
   - Reads the job record
   - Starts a heartbeat (updates timestamp periodically)
   - Runs `PiJobRunner` which spawns the `pi` CLI with the job's plan
   - Uses a PTY by default so interactive coding-agent behavior stays reliable during real edits
   - On completion, runs check commands (e.g., `bun run build`)
   - Writes final status back to the job record
4. **Review**: `review_job` runs a second brain instance against the diff + check results, producing an `approve | request_changes | reject` decision
5. **Continuation**: If review requests changes, `continueJobWithReview()` can retry with the updated plan (up to 2 iterations)

## File Structure

Each job gets its own directory:
```
{jobs.rootDir}/{jobId}/
├── job.json         # Job record (status, config, results)
├── plan.md          # The plan/instructions for the worker
├── events.jsonl     # Event stream
├── worker.log       # Stdout/stderr from the pi process
└── worktree/        # Isolated git worktree
```

## Config

```json
{
  "jobs": {
    "enabled": true,
    "rootDir": "./kroosbot-data/jobs",
    "defaultRuntime": "pi",
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-20250514",
    "defaultTimeoutMs": 600000,
    "maxConcurrentJobs": 2,
    "heartbeatIntervalMs": 60000,
    "staleHeartbeatMs": 120000,
    "runtimeCommand": "pi",
    "runtimeUsePty": true,
    "checks": {
      "commands": ["bun run build"]
    }
  }
}
```
