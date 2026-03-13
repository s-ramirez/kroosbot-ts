import path from "node:path";

export function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new Error(`Missing required string argument: ${name}`);
  }
  return parsed;
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveWorkspacePath(workspaceDir: string, requestedPath: string): string {
  const resolved = path.resolve(workspaceDir, requestedPath);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  return resolved;
}

export function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
