import fs from "node:fs/promises";
import path from "node:path";

export type WorkspaceContext = {
  soul?: string;
  heartbeat?: string;
};

export async function loadWorkspaceContext(workspaceDir: string): Promise<WorkspaceContext> {
  const [soul, heartbeat] = await Promise.all([
    readOptionalFile(path.join(workspaceDir, "SOUL.md")),
    readOptionalFile(path.join(workspaceDir, "HEARTBEAT.md"))
  ]);

  return {
    soul: normalizeMarkdownBlock(soul),
    heartbeat: normalizeMarkdownBlock(heartbeat)
  };
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeMarkdownBlock(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
