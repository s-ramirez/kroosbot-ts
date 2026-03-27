import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";
import type { RuntimeStore } from "../runtime-store/store.js";
import { createJobWorktree, getChangedFiles, getDiff, getDiffStat, getStatusShort, removeJobWorktree, resetWorktreeToBase, resolveBaseBranch, resolveBaseCommit } from "./git.js";
import { JobStore } from "./store.js";
import type { JobDelegatePayload, JobRecord, JobReviewDecision, JobReviewOutcome, JobStatus } from "./types.js";

export class JobSupervisor {
  private readonly store: JobStore;
  private readonly maxAutoReviewIterations = 2;
  private readonly statusTimeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short"
  });

  constructor(private readonly config: AppConfig, runtime?: RuntimeStore) {
    this.store = new JobStore(path.resolve(config.jobs.rootDir), runtime);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.reconcileRunningJobs();
  }

  async createAndStartJob(payload: JobDelegatePayload, plannerSessionKey: string): Promise<JobRecord> {
    await this.enforceConcurrency();

    const workspaceDir = path.resolve(payload.workspaceDir ?? this.config.app.workspaceDir);
    const baseBranch = await resolveBaseBranch(workspaceDir);
    const baseCommit = await resolveBaseCommit(workspaceDir);
    const jobId = createJobId();
    const worktreeDir = this.store.worktreeDir(jobId);
    const jobBranch = `codex/job-${jobId}`;
    await createJobWorktree({
      workspaceDir,
      worktreeDir,
      branch: jobBranch,
      baseCommit
    });

    const now = new Date().toISOString();
    const record: JobRecord = {
      id: jobId,
      title: payload.title,
      createdAt: now,
      updatedAt: now,
      workspaceDir,
      worktreeDir,
      baseBranch,
      jobBranch,
      baseCommit,
      status: "queued",
      plannerSessionKey,
      agentId: payload.agentId,
      runtime: "pi",
      modelConfig: {
        provider: payload.provider ?? this.config.jobs.defaultProvider,
        model: payload.model ?? (this.config.jobs.defaultModel || this.config.brain.openAiCompatible.model),
        apiKey: payload.apiKey || this.config.brain.openAiCompatible.apiKey,
        baseUrl: payload.baseUrl || this.config.brain.openAiCompatible.baseUrl,
        runtimeCommand: this.config.jobs.runtimeCommand,
        runtimeArgs: this.config.jobs.runtimeArgs
      },
      planDocument: payload.planDocument?.trim() || renderPlanDocument(payload),
      acceptanceCriteria: payload.acceptanceCriteria ?? [],
      checkCommands: payload.checkCommands ?? this.config.jobs.checks.commands,
      lastHeartbeatAt: now,
      resultSummary: undefined,
      reviewOutcome: undefined,
      reviewInstructions: payload.reviewInstructions,
      allowedScope: payload.allowedScope ?? [],
      outOfScope: payload.outOfScope ?? [],
      checklist: payload.checklist ?? [],
      checkResults: [],
      reviewIterationCount: 0
    };

    await this.store.createJob(record);
    await this.store.appendEvent(record.id, "job_created", `Job created: ${record.title}`);
    return this.startJob(record.id);
  }

  async startJob(id: string): Promise<JobRecord> {
    const job = await this.requireJob(id);
    const workerPath = resolveWorkerEntrypoint();
    const env = {
      ...process.env
    };
    const child = spawn(process.execPath, [workerPath, "--job", job.id], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env
    });
    child.unref();

    job.pid = child.pid;
    job.status = "running";
    job.lastHeartbeatAt = new Date().toISOString();
    await this.store.saveJob(job);
    await this.store.appendEvent(job.id, "worker_started", "Detached worker spawned", {
      pid: child.pid
    });
    return job;
  }

  async cancelJob(id: string): Promise<JobRecord> {
    const job = await this.requireJob(id);
    if (job.pid) {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
    job.status = "canceled";
    await this.store.saveJob(job);
    await this.store.appendEvent(job.id, "job_canceled", "Job canceled by user");
    return job;
  }

  async retryJob(
    id: string,
    agentOverrides?: { provider: string; model: string; baseUrl?: string; apiKey?: string }
  ): Promise<JobRecord> {
    const job = await this.requireJob(id);
    await resetWorktreeToBase({
      worktreeDir: job.worktreeDir,
      baseCommit: job.baseCommit
    });
    const refreshedProvider = agentOverrides?.provider ?? job.modelConfig.provider;
    const refreshedModel = agentOverrides?.model ?? job.modelConfig.model;
    const refreshedApiKey = agentOverrides?.apiKey ?? job.modelConfig.apiKey;
    const refreshedBaseUrl = agentOverrides?.baseUrl ?? job.modelConfig.baseUrl;
    job.status = "queued";
    job.resultSummary = undefined;
    job.checkResults = [];
    job.reviewOutcome = undefined;
    job.modelConfig = {
      provider: refreshedProvider,
      model: refreshedModel,
      apiKey: refreshedApiKey,
      baseUrl: refreshedBaseUrl,
      runtimeCommand: this.config.jobs.runtimeCommand,
      runtimeArgs: this.config.jobs.runtimeArgs
    };
    job.checkCommands = [...this.config.jobs.checks.commands];
    await this.store.saveJob(job);
    await this.store.appendEvent(
      job.id,
      "job_created",
      `Retrying job from clean reset state with provider=${refreshedProvider} model=${refreshedModel}`
    );
    return this.startJob(job.id);
  }

  async markReviewOutcome(id: string, decision: JobReviewDecision, summary: string, applied = true): Promise<JobRecord> {
    const job = await this.requireJob(id);
    const outcome: JobReviewOutcome = {
      decision,
      summary,
      reviewedAt: new Date().toISOString(),
      applied
    };
    job.reviewOutcome = outcome;

    if (!applied) {
      await this.store.appendEvent(job.id, "review_requested", summary, {
        decision
      });
    }

    if (applied && decision === "approve") {
      job.status = "completed";
      await this.store.appendEvent(job.id, "review_approved", summary);
    } else if (applied && decision === "reject") {
      await resetWorktreeToBase({
        worktreeDir: job.worktreeDir,
        baseCommit: job.baseCommit
      });
      job.status = "rejected";
      await this.store.appendEvent(job.id, "review_rejected", summary);
    } else if (decision === "request_changes") {
      job.status = "blocked";
    }

    await this.store.saveJob(job);
    await this.store.writeReview(
      job.id,
      [`# Review`, ``, `Decision: ${decision}`, ``, summary].join("\n")
    );
    return job;
  }

  async continueJobWithReview(id: string, reviewSummary: string): Promise<JobRecord> {
    await this.enforceConcurrency();
    const job = await this.requireJob(id);
    const reviewIterationCount = job.reviewIterationCount ?? 0;
    if (reviewIterationCount >= this.maxAutoReviewIterations) {
      throw new Error(
        `Auto review iteration limit reached (${this.maxAutoReviewIterations}). Review and delegate a fresh job or retry manually.`
      );
    }

    job.planDocument = appendReviewFeedback(job.planDocument, reviewSummary, reviewIterationCount + 1);
    job.reviewIterationCount = reviewIterationCount + 1;
    job.status = "queued";
    job.resultSummary = undefined;
    job.checkResults = [];
    job.reviewOutcome = undefined;
    await this.store.writePlan(job.id, job.planDocument);
    await this.store.saveJob(job);
    await this.store.appendEvent(
      job.id,
      "plan_revised",
      `Main assistant requested changes and restarted the worker (iteration ${job.reviewIterationCount}).`,
      { reviewSummary }
    );
    return this.startJob(job.id);
  }

  async listJobs(): Promise<JobRecord[]> {
    await this.reconcileRunningJobs();
    return this.store.listJobs();
  }

  async getJob(id: string): Promise<JobRecord | null> {
    await this.reconcileRunningJobs();
    return this.store.getJob(id);
  }

  async clearJob(id: string): Promise<JobRecord> {
    const job = await this.requireJob(id);
    if (!isClearableJobStatus(job.status)) {
      throw new Error(`Job ${job.id} is ${job.status} and cannot be cleared. Only blocked or failed jobs can be cleared.`);
    }
    await this.removeJobArtifacts(job);
    return job;
  }

  async clearJobs(statuses: JobStatus[] = ["blocked", "failed"]): Promise<JobRecord[]> {
    await this.reconcileRunningJobs();
    const jobs = await this.store.listJobs();
    const toClear = jobs.filter((job) => statuses.includes(job.status) && isClearableJobStatus(job.status));
    for (const job of toClear) {
      await this.removeJobArtifacts(job);
    }
    return toClear;
  }

  async getJobStatusReport(id: string): Promise<string> {
    const job = await this.requireJob(id);
    const events = await this.store.readRecentEvents(id, 8);
    const checks = job.checkResults.length > 0
      ? job.checkResults
        .map((entry) => {
          const startedAt = this.formatTimestamp(entry.startedAt);
          const finishedAt = this.formatTimestamp(entry.finishedAt);
          return `- ${entry.ok ? "PASS" : "FAIL"} ${entry.command} (exit ${entry.exitCode}; ${startedAt} -> ${finishedAt})`;
        })
        .join("\n")
      : "No checks recorded.";
    const eventText = events.length > 0
      ? events
        .map((event) => `- ${this.formatTimestamp(event.at)} ${event.type}${event.message ? `: ${event.message}` : ""}`)
        .join("\n")
      : "No recent events.";
    return [
      `Job ${job.id}: ${job.title}`,
      `Status: ${job.status}`,
      `Workspace: ${job.workspaceDir}`,
      `Worktree: ${job.worktreeDir}`,
      `Branch: ${job.jobBranch}`,
      `Base: ${job.baseBranch} @ ${job.baseCommit}`,
      `Runtime: ${job.runtime}`,
      `Model: ${job.modelConfig.provider}/${job.modelConfig.model}`,
      `Review iterations: ${job.reviewIterationCount ?? 0}/${this.maxAutoReviewIterations}`,
      `Last heartbeat: ${job.lastHeartbeatAt ? this.formatTimestamp(job.lastHeartbeatAt) : "never"}`,
      job.resultSummary ? `Summary: ${job.resultSummary}` : null,
      job.blockerQuestion ? `Blocker question: ${job.blockerQuestion}` : null,
      "",
      `Checks:`,
      checks,
      "",
      `Recent events:`,
      eventText
    ].filter(Boolean).join("\n");
  }

  async getJobLog(id: string, maxChars = 4000): Promise<string> {
    await this.requireJob(id);
    return this.store.readLogTail(id, maxChars);
  }

  async collectReviewContext(id: string): Promise<{
    job: JobRecord;
    diffStat: string;
    changedFiles: string[];
    diff: string;
    statusShort: string;
  }> {
    const job = await this.requireJob(id);
    return {
      job,
      diffStat: await getDiffStat(job.worktreeDir, job.baseCommit),
      changedFiles: await getChangedFiles(job.worktreeDir, job.baseCommit),
      diff: await getDiff(job.worktreeDir, job.baseCommit),
      statusShort: await getStatusShort(job.worktreeDir)
    };
  }

  private async requireJob(id: string): Promise<JobRecord> {
    const job = await this.store.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  private async removeJobArtifacts(job: JobRecord): Promise<void> {
    await removeJobWorktree({
      workspaceDir: job.workspaceDir,
      worktreeDir: job.worktreeDir
    }).catch(() => undefined);
    await this.store.deleteJob(job.id);
  }

  private async enforceConcurrency(): Promise<void> {
    const jobs = await this.store.listJobs();
    const running = jobs.filter((job) => job.status === "running");
    if (running.length >= this.config.jobs.maxConcurrentJobs) {
      throw new Error(`Max concurrent jobs reached (${this.config.jobs.maxConcurrentJobs})`);
    }
  }

  private async reconcileRunningJobs(): Promise<void> {
    const jobs = await this.store.listJobs();
    const now = Date.now();
    for (const job of jobs) {
      if (job.status !== "running") continue;
      const lastHeartbeat = job.lastHeartbeatAt ? Date.parse(job.lastHeartbeatAt) : 0;
      const stale = lastHeartbeat > 0 && now - lastHeartbeat > this.config.jobs.staleHeartbeatMs;
      const dead = job.pid ? !isPidAlive(job.pid) : false;
      if (!stale && !dead) continue;
      job.status = "failed";
      job.resultSummary = stale
        ? "Worker heartbeat went stale."
        : "Worker process exited unexpectedly.";
      await this.store.saveJob(job);
    }
  }

  private formatTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return this.statusTimeFormatter.format(date);
  }
}

function appendReviewFeedback(planDocument: string, reviewSummary: string, iteration: number): string {
  return [
    planDocument.trim(),
    "",
    `## Review Feedback Revision ${iteration}`,
    "",
    "The main assistant reviewed the previous result and requested these concrete changes:",
    reviewSummary.trim(),
    "",
    "Update the existing worktree changes to satisfy this review feedback before stopping again."
  ].join("\n");
}

function renderPlanDocument(payload: JobDelegatePayload): string {
  return [
    `# ${payload.title}`,
    "",
    "## Summary",
    payload.summary,
    "",
    "## Checklist",
    ...(payload.checklist ?? []).map((item) => `- ${item}`),
    "",
    "## Acceptance Criteria",
    ...(payload.acceptanceCriteria ?? []).map((item) => `- ${item}`),
    "",
    "## Allowed Scope",
    ...(payload.allowedScope ?? []).map((item) => `- ${item}`),
    "",
    "## Out of Scope",
    ...(payload.outOfScope ?? []).map((item) => `- ${item}`)
  ].join("\n");
}

function createJobId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveWorkerEntrypoint(): string {
  const distPath = path.resolve(process.cwd(), "dist/jobs/worker.js");
  const srcPath = path.resolve(process.cwd(), "src/jobs/worker.ts");
  return fileExists(distPath) ? distPath : srcPath;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

function isClearableJobStatus(status: JobStatus): boolean {
  return status === "blocked" || status === "failed";
}
