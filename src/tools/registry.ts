import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { MemoryManager } from "../memory/manager.js";
import type {
  PendingToolApproval,
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult
} from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly pendingApprovals = new Map<string, PendingToolApproval>();
  private nextApprovalId = 1;

  constructor(tools: Tool[]) {
    for (const tool of tools) {
      this.tools.set(tool.definition.name, tool);
    }
  }

  static createBuiltIn(config: AppConfig, memory: MemoryManager): ToolRegistry {
    const workspaceDir = path.resolve(config.app.workspaceDir);
    return new ToolRegistry([
      new MemorySearchTool(memory),
      new MemoryWriteTool(memory),
      new ListFilesTool(workspaceDir),
      new ReadFileTool(workspaceDir)
    ]);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, content: `Unknown tool: ${name}` };
    }

    if ((tool.definition.approvalMode ?? "none") === "always") {
      const pending = this.createPendingApproval(name, args, context);
      return {
        ok: false,
        requiresApproval: true,
        approvalId: pending.id,
        content: `Approval required. Pending request ${pending.id} for ${name}. Ask the user to run /approve ${pending.id} or /deny ${pending.id}.`
      };
    }

    try {
      return await tool.execute(args);
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error)
      };
    }
  }

  listPendingApprovals(sessionKey?: string): PendingToolApproval[] {
    const values = [...this.pendingApprovals.values()];
    return values
      .filter((entry) => !sessionKey || entry.sessionKey === sessionKey)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async approve(id: string): Promise<ToolExecutionResult & { toolName: string }> {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return { ok: false, toolName: "unknown", content: `No pending approval found for ${id}.` };
    }

    const tool = this.tools.get(pending.toolName);
    if (!tool) {
      this.pendingApprovals.delete(id);
      return { ok: false, toolName: pending.toolName, content: `Tool no longer exists: ${pending.toolName}` };
    }

    this.pendingApprovals.delete(id);
    try {
      const result = await tool.execute(pending.arguments);
      return { ...result, toolName: pending.toolName };
    } catch (error) {
      return {
        ok: false,
        toolName: pending.toolName,
        content: error instanceof Error ? error.message : String(error)
      };
    }
  }

  deny(id: string): PendingToolApproval | null {
    const pending = this.pendingApprovals.get(id) ?? null;
    if (pending) {
      this.pendingApprovals.delete(id);
    }
    return pending;
  }

  private createPendingApproval(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): PendingToolApproval {
    const existing = [...this.pendingApprovals.values()].find((entry) =>
      entry.sessionKey === context.sessionKey &&
      entry.toolName === toolName &&
      JSON.stringify(entry.arguments) === JSON.stringify(args)
    );
    if (existing) {
      return existing;
    }

    const approval: PendingToolApproval = {
      id: String(this.nextApprovalId++),
      sessionKey: context.sessionKey,
      toolName,
      arguments: args,
      requestedAt: new Date().toISOString()
    };
    this.pendingApprovals.set(approval.id, approval);
    return approval;
  }
}

class MemorySearchTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "memory_search",
    description: "Search durable memory notes for relevant information.",
    parameters: [
      {
        name: "query",
        type: "string",
        description: "What to search for in memory.",
        required: true
      }
    ]
  };

  constructor(private readonly memory: MemoryManager) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
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
  readonly definition: ToolDefinition = {
    name: "memory_write",
    description: "Write a durable memory note for future retrieval when the user shares a lasting preference, decision, personal fact, or other information that is likely to matter later.",
    approvalMode: "always",
    parameters: [
      {
        name: "text",
        type: "string",
        description: "A short normalized memory note to save, written as a durable fact and not a transcript quote.",
        required: true
      },
      {
        name: "category",
        type: "string",
        description: "Optional category like preference, decision, todo, note, or project."
      }
    ]
  };

  constructor(private readonly memory: MemoryManager) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const text = requiredString(args.text, "text");
    const category = optionalString(args.category);
    const targetPath = await this.memory.appendNote({ text, category });
    return { ok: true, content: `Saved memory note to ${targetPath}.` };
  }
}

class ListFilesTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "list_files",
    description: "List files and directories under the configured workspace.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Optional relative path under the workspace to list."
      }
    ]
  };

  constructor(private readonly workspaceDir: string) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const requestedPath = optionalString(args.path) ?? ".";
    const targetDir = resolveWorkspacePath(this.workspaceDir, requestedPath);
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const lines = entries
      .slice(0, 200)
      .map((entry) => `${entry.isDirectory() ? "dir" : "file"} ${entry.name}`);
    return {
      ok: true,
      content: lines.length > 0
        ? `Listing for ${path.relative(this.workspaceDir, targetDir) || "."}:\n${lines.join("\n")}`
        : `No entries found for ${path.relative(this.workspaceDir, targetDir) || "."}.`
    };
  }
}

class ReadFileTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "read_file",
    description: "Read a text file from the configured workspace.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative file path under the workspace.",
        required: true
      }
    ]
  };

  constructor(private readonly workspaceDir: string) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const requestedPath = requiredString(args.path, "path");
    const targetPath = resolveWorkspacePath(this.workspaceDir, requestedPath);
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${requestedPath}`);
    }
    const raw = await fs.readFile(targetPath, "utf8");
    const content = raw.length > 12000 ? `${raw.slice(0, 12000).trimEnd()}\n...` : raw;
    return {
      ok: true,
      content: `File: ${path.relative(this.workspaceDir, targetPath) || path.basename(targetPath)}\n${content}`
    };
  }
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new Error(`Missing required string argument: ${name}`);
  }
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveWorkspacePath(workspaceDir: string, requestedPath: string): string {
  const resolved = path.resolve(workspaceDir, requestedPath);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  return resolved;
}
