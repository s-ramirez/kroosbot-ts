import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppConfig } from "../../config.js";
import { JobStore } from "../store.js";
import { getChangedFiles, getStatusShort } from "../git.js";
import type { JobCheckResult, JobRecord } from "../types.js";

export class PiJobRunner {
  private child: ChildProcess | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JobStore
  ) {}

  async run(job: JobRecord): Promise<{
    status: "ready_for_review" | "blocked" | "failed";
    summary: string;
    checks: JobCheckResult[];
    blockerQuestion?: string;
  }> {
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
    const resolvedApiKey =
      job.modelConfig.apiKey?.trim() ||
      (job.modelConfig.provider === "openai" && job.modelConfig.baseUrl ? "local-openai" : "");
    if (resolvedApiKey) {
      env.OPENAI_API_KEY = resolvedApiKey;
    }
    if (job.modelConfig.baseUrl) env.OPENAI_BASE_URL = job.modelConfig.baseUrl;
    await this.store.appendLog(
      job.id,
      `Using provider=${job.modelConfig.provider} model=${job.modelConfig.model} baseUrl=${job.modelConfig.baseUrl ?? "(default)"} apiKey=${resolvedApiKey ? "[set]" : "[missing]"}\n`
    );

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

    const workerResult = parseWorkerResult(stdout);
    const checks = await runChecks(this.store, job, this.config.jobs.defaultTimeoutMs);
    const failing = checks.find((entry) => !entry.ok);
    if (failing) {
      return {
        status: "blocked",
        summary: `Checks failed: ${failing.command}\n${clampText(failing.output, 2000)}`,
        checks,
        blockerQuestion: workerResult?.blockerQuestion
      };
    }

    const changedFiles = await getChangedFiles(job.worktreeDir, job.baseCommit);
    const statusShort = await getStatusShort(job.worktreeDir);
    if (changedFiles.length === 0) {
      const summary = clampText(
        [
          "pi completed without producing any file changes.",
          "The task may already be satisfied, or the worker stopped early.",
          workerResult?.summary ? `Worker summary:\n${workerResult.summary}` : null,
          stdout.trim() ? `Worker output:\n${stdout.trim()}` : null,
          statusShort ? `Git status:\n${statusShort}` : null
        ]
          .filter(Boolean)
          .join("\n\n"),
        3000
      );
      return {
        status: "blocked",
        summary,
        checks,
        blockerQuestion: workerResult?.blockerQuestion
      };
    }

    const summary = clampText(workerResult?.summary || stdout.trim() || "pi completed successfully.", 3000);
    return { status: "ready_for_review", summary, checks, blockerQuestion: workerResult?.blockerQuestion };
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
    `If the repository already satisfies the plan, say that explicitly in your final message instead of pretending work was done.`,
    `Your very last line must be exactly one JSON object prefixed by RESULT_JSON:.`,
    `Use this exact shape: RESULT_JSON: {"summary":"short summary","blockerQuestion":"one focused question or empty string"}`,
    `If you are not blocked, set blockerQuestion to an empty string.`,
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

function parseWorkerResult(stdout: string): { summary: string; blockerQuestion?: string } | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  const marker = "RESULT_JSON:";
  const candidate = lines.find((line) => line.startsWith(marker));
  if (!candidate) return null;

  const json = candidate.slice(marker.length).trim();
  try {
    const parsed = JSON.parse(json) as { summary?: unknown; blockerQuestion?: unknown };
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const blockerQuestion = typeof parsed.blockerQuestion === "string"
      ? parsed.blockerQuestion.trim()
      : "";
    if (!summary) return null;
    return {
      summary,
      blockerQuestion: blockerQuestion || undefined
    };
  } catch {
    return null;
  }
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
