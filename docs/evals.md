# Eval System

The eval harness tests tool-decision quality — given a message and context, does the brain call the right tools?

**Files:** `src/evals/types.ts`, `src/evals/runner.ts`, `src/evals/cli.ts`

## Running Evals

```bash
bun run evals                            # default: evals/tool-decisions.json
bun run evals ./evals/some-suite.json    # specific suite
```

## Eval Case Structure

Each case in a suite JSON file defines:

```json
{
  "name": "descriptive test name",
  "input": "user message to test",
  "history": [],
  "workspaceFiles": {},
  "memoryNotes": [],
  "expected": {
    "mustCallAll": ["tool_a", "tool_b"],
    "mustCallAnyOf": ["tool_c", "tool_d"],
    "mustNotCall": ["tool_e"],
    "finalAnswerContains": ["keyword"],
    "finalAnswerNotContains": ["bad_keyword"]
  }
}
```

## Expectations

| Field | Meaning |
|-------|---------|
| `mustCallAll` | All listed tools must be called |
| `mustCallAnyOf` | At least one listed tool must be called |
| `mustNotCall` | None of listed tools should be called |
| `finalAnswerContains` | Final response must include these strings |
| `finalAnswerNotContains` | Final response must not include these strings |

## Results

Each case produces an `EvalCaseResult` with:
- `passed` — whether all expectations were met
- `failures` — list of unmet expectations
- `finalAnswer` — the brain's response text
- `calledTools` — tools that were invoked
- `trace` — full tool trace for debugging
