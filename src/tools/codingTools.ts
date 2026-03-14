import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolExecutionResult } from "./types.js";
import { clampText, optionalString, requiredString, resolveWorkspacePath } from "./shared.js";

export function createCodingTools(workspaceDir: string): Tool[] {
  return [
    new ListFilesTool(workspaceDir),
    new SearchFilesTool(workspaceDir),
    new ReadFileTool(workspaceDir)
  ];
}

class ListFilesTool implements Tool {
  readonly definition = {
    name: "list_files",
    description: "List files and directories under the configured workspace.",
    parameters: [
      {
        name: "path",
        type: "string" as const,
        description: "Optional relative path under the workspace to list."
      }
    ]
  };

  constructor(private readonly workspaceDir: string) {}

  async execute(args: Record<string, unknown>, _context: { sessionKey: string }): Promise<ToolExecutionResult> {
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

class SearchFilesTool implements Tool {
  readonly definition = {
    name: "search_files",
    description: "Search text files in the workspace for a query string or regex-like pattern.",
    parameters: [
      {
        name: "query",
        type: "string" as const,
        description: "Text to search for in file contents.",
        required: true
      },
      {
        name: "path",
        type: "string" as const,
        description: "Optional relative directory or file path under the workspace to search."
      }
    ]
  };

  constructor(private readonly workspaceDir: string) {}

  async execute(args: Record<string, unknown>, _context: { sessionKey: string }): Promise<ToolExecutionResult> {
    const query = requiredString(args.query, "query");
    const requestedPath = optionalString(args.path) ?? ".";
    const targetPath = resolveWorkspacePath(this.workspaceDir, requestedPath);
    const matches: string[] = [];
    await this.walkAndSearch(targetPath, query, matches);
    if (matches.length === 0) {
      return { ok: true, content: `No matches found for "${query}" in ${requestedPath}.` };
    }
    return {
      ok: true,
      content: clampText(matches.slice(0, 100).join("\n"), 12000)
    };
  }

  private async walkAndSearch(targetPath: string, query: string, matches: string[]): Promise<void> {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
      await searchFile(this.workspaceDir, targetPath, query, matches);
      return;
    }

    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= 100) break;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      const childPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        await this.walkAndSearch(childPath, query, matches);
        continue;
      }
      if (entry.isFile()) {
        await searchFile(this.workspaceDir, childPath, query, matches);
      }
    }
  }
}

class ReadFileTool implements Tool {
  readonly definition = {
    name: "read_file",
    description: "Read a text file from the configured workspace.",
    parameters: [
      {
        name: "path",
        type: "string" as const,
        description: "Relative file path under the workspace.",
        required: true
      }
    ]
  };

  constructor(private readonly workspaceDir: string) {}

  async execute(args: Record<string, unknown>, _context: { sessionKey: string }): Promise<ToolExecutionResult> {
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

async function searchFile(
  workspaceDir: string,
  filePath: string,
  query: string,
  matches: string[]
): Promise<void> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (raw === null || raw.includes("\u0000")) {
    return;
  }

  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (matches.length >= 100) break;
    const line = lines[index] ?? "";
    if (!line.toLowerCase().includes(query.toLowerCase())) {
      continue;
    }
    matches.push(`${path.relative(workspaceDir, filePath)}:${index + 1}: ${clampText(line.trim(), 200)}`);
  }
}
