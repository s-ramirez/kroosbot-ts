# Memory System

Kroosbot uses file-backed durable memory with keyword-based search. Memory is injected into the system prompt before every brain reply to provide relevant context.

## How It Works

**Files:** `src/memory/manager.ts`, `src/memory/types.ts`, `src/memory/autoExtract.ts`

### Storage

Memory is stored as Markdown files:
- `MEMORY.md` — top-level index
- `memory/*.md` — categorized notes (e.g., `preference`, `decision`, `todo`)

Notes are appended to date-stamped files (`YYYY-MM-DD.md`) within the memory directory.

### Search

`MemoryManager.search(query)` tokenizes the query and scores memory blocks by matching against:
- Block text content
- Titles (h1/h2 headings)
- Categories (from filename)
- Tags (if present)

Returns the top N results (configurable via `maxResults`) with snippets clamped to `maxSnippetChars`.

### Auto-Extract

When `autoRemember` is enabled, `extractAutoMemoryCandidate()` scans user messages for patterns like:
- Preferences: "I like...", "I prefer...", "my favorite..."
- Decisions: "we decided...", "I decided..."

Detected candidates are proposed as memory writes (still subject to approval).

### Integration with Brain

Before every `brain.reply()` call, the app:
1. Searches memory for terms relevant to the current message
2. Injects matching snippets into the system prompt via `buildSystemPrompt()`
3. The brain can also call `memory_search` and `memory_write` tools explicitly

## Config

```json
{
  "memory": {
    "enabled": true,
    "rootDir": "./kroosbot-data/memory",
    "indexFile": "MEMORY.md",
    "maxResults": 5,
    "maxSnippetChars": 300,
    "autoRemember": { "enabled": true }
  }
}
```
