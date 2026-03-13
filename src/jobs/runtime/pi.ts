import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppConfig } from "../../config.js";
import { JobStore } from "../store.js";
import type { JobCheckResult, JobRecord } from "../types.js";

export class PiJobRunner {
  private child: ChildProcess | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JobStore
  ) {}

  async run(job: JobRecord): Promise<{ status: "ready_for_review" | "blocked" | "failed"; summary: string; checks: JobCheckResult[] }> {
    const promptPath = `${this.store.jobDir(job.id)}/worker-prompt.md`;
    const prompt = buildWorkerPrompt(job);
    await this.store.appendLog(job.id, `Starting pi runtime for ${job.id}\n`);
    await fs.writeFile(promptPath, prompt, "utf8");

    const args = [
      ...job.modelConfig.runtimeArgs,
      "--provider",
      job.modelConfig.provider,
      "--model",
      job.modelConfig.model,
      "--tools",
      "read,bash,edit,write,grep,find,ls",
      "--session-dir",
      `${this.store.jobDir(job.id)}/pi-session`,
      "--print",
      `@${promptPath}`,
      "Execute the plan in the current repository, update the code, run the required checks when appropriate, and stop when the task is complete or blocked."
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env
    };
    if (job.modelConfig.apiKey) env.OPENAI_API_KEY = job.modelConfig.apiKey;
    if (job.modelConfig.baseUrl) env.OPENAI_BASE_URL = job.modelConfig.baseUrl;

    const child = spawn(job.modelConfig.runtimeCommand, args, {
      cwd: job.worktreeDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;

    let stdout = "";
    let stderr = "";
    wireLineLogging(child.stdout, async (line) => {
      stdout += `${line}\n`;
      await this.store.appendLog(job.id, `[pi stdout] ${line}\n`);
      await this.store.appendEvent(job.id, "step_note", line.slice(0, 240));
    });
    wireLineLogging(child.stderr, async (line) => {
      stderr += `${line}\n`;
      await this.store.appendLog(job.id, `[pi stderr] ${line}\n`);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
    }).catch(async (error) => {
      await this.store.appendLog(job.id, `[pi error] ${String(error)}\n`);
      return -1;
    });

    if (exitCode !== 0) {
      const summary = clampText([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), 3000);
      return { status: "failed", summary: summary || `pi exited with code ${exitCode}`, checks: [] };
    }

    const checks = await runChecks(this.store, job, this.config.jobs.defaultTimeoutMs);
    const failing = checks.find((entry) => !entry.ok);
    if (failing) {
      return {
        status: "blocked",
        summary: `Checks failed: ${failing.command}\n${clampText(failing.output, 2000)}`,
        checks
      };
    }

    const summary = clampText(stdout.trim() || "pi completed successfully.", 3000);
    return { status: "ready_for_review", summary, checks };
  }

  stop(): void {
    if (!this.child?.pid) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

function buildWorkerPrompt(job: JobRecord): string {
  return [
    `You are executing a background coding job in an isolated git worktree.`,
    `Follow the plan exactly. Do not redefine scope.`,
    `If you are blocked, explain the blocker clearly in your final message.`,
    "",
    `Job: ${job.title}`,
    `Workspace: ${job.worktreeDir}`,
    `Base branch: ${job.baseBranch}`,
    `Job branch: ${job.jobBranch}`,
    "",
    "Plan:",
    job.planDocument,
    "",
    "Acceptance criteria:",
    ...job.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "Checklist:",
    ...job.checklist.map((item) => `- ${item}`),
    "",
    "Allowed scope:",
    ...job.allowedScope.map((item) => `- ${item}`),
    "",
    "Out of scope:",
    ...job.outOfScope.map((item) => `- ${item}`),
    "",
    "Review instructions:",
    job.reviewInstructions || "Make the smallest defensible change set and leave the repo in a reviewable state."
  ].join("\n");
}

function wireLineLogging(stream: NodeJS.ReadableStream, onLine: (line: string) => Promise<void>): void {
  const rl = createInterface({ input: stream });
  rl.on("line", (line) => {
    void onLine(line);
  });
}

async function runChecks(store: JobStore, job: JobRecord, timeoutMs: number): Promise<JobCheckResult[]> {
  const results: JobCheckResult[] = [];
  for (const command of job.checkCommands) {
    const startedAt = new Date().toISOString();
    await store.appendEvent(job.id, "check_started", command);
    const child = spawn("zsh", ["-lc", command], {
      cwd: job.worktreeDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      void store.appendLog(job.id, `[check stdout] ${text}`);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      void store.appendLog(job.id, `[check stderr] ${text}`);
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(1));
    });
    clearTimeout(timeout);

    const finishedAt = new Date().toISOString();
    const result: JobCheckResult = {
      command,
      exitCode,
      ok: exitCode === 0,
      startedAt,
      finishedAt,
      output: clampText(output.trim(), 4000)
    };
    results.push(result);
    await store.appendEvent(job.id, "check_finished", command, {
      exitCode,
      ok: result.ok
    });
  }
  return results;
}

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`;
}
