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
      "--append-system-prompt",
      buildRuntimeSystemPrompt(),
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

    const child = spawnPiProcess({
      command: job.modelConfig.runtimeCommand,
      args,
      cwd: job.worktreeDir,
      env,
      usePty: this.config.jobs.runtimeUsePty
    });
    this.child = child;

    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      wireLineLogging(child.stdout, async (line) => {
        stdout += `${line}\n`;
        await this.store.appendLog(job.id, `[pi stdout] ${line}\n`);
        await this.store.appendEvent(job.id, "step_note", line.slice(0, 240));
      });
    }
    if (child.stderr) {
      wireLineLogging(child.stderr, async (line) => {
        stderr += `${line}\n`;
        await this.store.appendLog(job.id, `[pi stderr] ${line}\n`);
      });
    }

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
    const sessionDiagnosis = await diagnosePiSession(this.store.jobDir(job.id));
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
          sessionDiagnosis ? `Session diagnosis:\n${sessionDiagnosis}` : null,
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
    `You are allowed to read, edit, and create files inside this worktree when the plan requires it.`,
    `Use the runtime's native tools directly. Plain-text tool syntax like <tool_call>, <function=...>, markdown code fences, or narrated shell commands will not execute.`,
    `If the task requires a code or file change, make the change instead of only describing it.`,
    `Keep using native tool calls until the filesystem reflects the requested change or you have a real blocker.`,
    `Before you finish, verify the result in the filesystem and verify that git status or git diff reflects the intended change when one is required.`,
    `Do not claim success unless the acceptance criteria are satisfied in the worktree right now.`,
    `If the task requires a change but git diff is empty, treat that as blocked or already satisfied and explain which one is true.`,
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

function buildRuntimeSystemPrompt(): string {
  return [
    "You are running inside the pi coding runtime with native tools.",
    "When you need to read, search, edit, write, or run shell commands, invoke the native tool directly.",
    "Do not emit pseudo-tool markup in plain text.",
    "Never output formats like <tool_call>, <function=...>, XML wrappers, or fenced shell snippets as a substitute for a real tool call.",
    "If you need bash, call the bash tool directly."
  ].join(" ");
}

function spawnPiProcess(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  usePty: boolean;
}): ChildProcess {
  if (!params.usePty) {
    return spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  if (process.platform === "darwin") {
    return spawn("script", ["-q", "/dev/null", params.command, ...params.args], {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  if (process.platform === "linux") {
    return spawn("script", ["-qec", shellEscape([params.command, ...params.args]), "/dev/null"], {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  return spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function shellEscape(parts: string[]): string {
  return parts
    .map((part) => {
      if (/^[A-Za-z0-9_./:=+-]+$/.test(part)) return part;
      return `'${part.replace(/'/g, `'\"'\"'`)}'`;
    })
    .join(" ");
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

async function diagnosePiSession(jobDir: string): Promise<string | null> {
  const sessionDir = `${jobDir}/pi-session`;
  const latestSession = await findLatestSessionFile(sessionDir);
  if (!latestSession) return null;

  const raw = await fs.readFile(latestSession, "utf8").catch(() => "");
  if (!raw.trim()) return null;

  const records = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  const pseudoToolSnippet = findPseudoToolSnippet(records);
  if (pseudoToolSnippet) {
    return `The model emitted plain-text pseudo-tool syntax instead of a native tool call: ${pseudoToolSnippet}`;
  }

  const lastAssistantText = findLastAssistantText(records);
  return lastAssistantText ? `Last assistant output: ${lastAssistantText}` : null;
}

async function findLatestSessionFile(sessionDir: string): Promise<string | null> {
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();
  if (candidates.length === 0) return null;
  return `${sessionDir}/${candidates[candidates.length - 1]}`;
}

function findPseudoToolSnippet(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    const message = getMessageRecord(record);
    if (!message || message.role !== "assistant") continue;
    for (const snippet of extractContentStrings(message.content)) {
      if (!/<tool_call>|<function=|<\/function>|<\/tool_call>/.test(snippet)) continue;
      return clampText(snippet.replace(/\s+/g, " ").trim(), 240);
    }
  }
  return null;
}

function findLastAssistantText(records: Record<string, unknown>[]): string | null {
  for (const record of [...records].reverse()) {
    const message = getMessageRecord(record);
    if (!message || message.role !== "assistant") continue;
    const snippets = extractContentStrings(message.content)
      .map((snippet) => snippet.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (snippets.length > 0) {
      return clampText(snippets.join(" "), 240);
    }
  }
  return null;
}

function getMessageRecord(
  record: Record<string, unknown>
): { role?: string; content?: unknown } | null {
  const message = record.message;
  if (!message || typeof message !== "object") return null;
  return message as { role?: string; content?: unknown };
}

function extractContentStrings(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const snippets: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const textValue = (item as { text?: unknown }).text;
    if (typeof textValue === "string" && textValue.trim()) {
      snippets.push(textValue);
    }
    const thinkingValue = (item as { thinking?: unknown }).thinking;
    if (typeof thinkingValue === "string" && thinkingValue.trim()) {
      snippets.push(thinkingValue);
    }
  }
  return snippets;
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
