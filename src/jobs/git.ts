import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

export async function resolveBaseBranch(workspaceDir: string): Promise<string> {
  const { stdout } = await runGit(workspaceDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

export async function resolveBaseCommit(workspaceDir: string): Promise<string> {
  const { stdout } = await runGit(workspaceDir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function createJobWorktree(params: {
  workspaceDir: string;
  worktreeDir: string;
  branch: string;
  baseCommit: string;
}): Promise<void> {
  await fs.mkdir(params.worktreeDir, { recursive: true });
  await runGit(params.workspaceDir, ["worktree", "add", "-B", params.branch, params.worktreeDir, params.baseCommit]);
}

export async function resetWorktreeToBase(params: {
  worktreeDir: string;
  baseCommit: string;
}): Promise<void> {
  await runGit(params.worktreeDir, ["reset", "--hard", params.baseCommit]);
  await runGit(params.worktreeDir, ["clean", "-fd"]);
}

export async function getDiffStat(worktreeDir: string, baseCommit: string): Promise<string> {
  const { stdout } = await runGit(worktreeDir, ["diff", "--stat", baseCommit]);
  return stdout.trim();
}

export async function getChangedFiles(worktreeDir: string, baseCommit: string): Promise<string[]> {
  const { stdout } = await runGit(worktreeDir, ["diff", "--name-only", baseCommit]);
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function getDiff(worktreeDir: string, baseCommit: string): Promise<string> {
  const { stdout } = await runGit(worktreeDir, ["diff", "--unified=2", baseCommit], 20000);
  return stdout.trim();
}

export async function getStatusShort(worktreeDir: string): Promise<string> {
  const { stdout } = await runGit(worktreeDir, ["status", "--short"]);
  return stdout.trim();
}

async function runGit(cwd: string, args: string[], maxBuffer = 10_000_000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, maxBuffer });
}
