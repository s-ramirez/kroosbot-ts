import type { MemoryManager } from "../memory/manager.js";
import type { Tool, ToolExecutionResult } from "./types.js";
import { optionalString, requiredString } from "./shared.js";

export function createMemoryTools(memory: MemoryManager): Tool[] {
  return [
    new MemorySearchTool(memory),
    new MemoryWriteTool(memory)
  ];
}

class MemorySearchTool implements Tool {
  readonly definition = {
    name: "memory_search",
    description: "Search durable memory notes for relevant information.",
    parameters: [
      {
        name: "query",
        type: "string" as const,
        description: "What to search for in memory.",
        required: true
      }
    ]
  };

  constructor(private readonly memory: MemoryManager) {}

  async execute(args: Record<string, unknown>, _context: { sessionKey: string }): Promise<ToolExecutionResult> {
    const query = requiredString(args.query, "query");
    const results = await this.memory.search(query);
    if (results.length === 0) {
      return { ok: true, content: `No memory results found for "${query}".` };
    }
    const lines = results.map((entry, index) => {
      const suffix = entry.endLine > entry.startLine ? `-L${entry.endLine}` : "";
      return `${index + 1}. ${entry.path}#L${entry.startLine}${suffix} [score=${entry.score}] ${entry.snippet}`;
    });
    return { ok: true, content: lines.join("\n") };
  }
}

class MemoryWriteTool implements Tool {
  readonly definition = {
    name: "memory_write",
    description: "Write a durable memory note for future retrieval when the user shares a lasting preference, decision, personal fact, or other information that is likely to matter later.",
    approvalMode: "always" as const,
    parameters: [
      {
        name: "text",
        type: "string" as const,
        description: "A short normalized memory note to save, written as a durable fact and not a transcript quote.",
        required: true
      },
      {
        name: "category",
        type: "string" as const,
        description: "Optional category like preference, decision, todo, note, or project."
      }
    ]
  };

  constructor(private readonly memory: MemoryManager) {}

  async execute(args: Record<string, unknown>, _context: { sessionKey: string }): Promise<ToolExecutionResult> {
    const text = requiredString(args.text, "text");
    const category = optionalString(args.category);
    const targetPath = await this.memory.appendNote({ text, category });
    return { ok: true, content: `Saved memory note to ${targetPath}.` };
  }
}
