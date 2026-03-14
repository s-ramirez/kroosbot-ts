import fs from "node:fs/promises";
import path from "node:path";
import type { JobEvent, JobEventType, JobRecord, JobReviewOutcome } from "./types.js";

export class JobStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  root(): string {
    return this.rootDir;
  }

  jobDir(id: string): string {
    return path.join(this.rootDir, id);
  }

  worktreeDir(id: string): string {
    return path.join(this.jobDir(id), "worktree");
  }

  workerLogPath(id: string): string {
    return path.join(this.jobDir(id), "worker.log");
  }

  async createJob(record: JobRecord): Promise<void> {
    const dir = this.jobDir(record.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.jobFilePath(record.id), JSON.stringify(record, null, 2), "utf8");
    await fs.writeFile(this.planFilePath(record.id), record.planDocument, "utf8");
    await fs.writeFile(this.eventsFilePath(record.id), "", "utf8");
    await fs.writeFile(this.workerLogPath(record.id), "", "utf8");
  }

  async getJob(id: string): Promise<JobRecord | null> {
    try {
      const raw = await fs.readFile(this.jobFilePath(id), "utf8");
      return JSON.parse(raw) as JobRecord;
    } catch {
      return null;
    }
  }

  async listJobs(): Promise<JobRecord[]> {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const jobs: JobRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await this.getJob(entry.name);
      if (job) jobs.push(job);
    }
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveJob(record: JobRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await fs.writeFile(this.jobFilePath(record.id), JSON.stringify(record, null, 2), "utf8");
  }

  async appendEvent(id: string, type: JobEventType, message?: string, data?: Record<string, unknown>): Promise<void> {
    const event: JobEvent = {
      at: new Date().toISOString(),
      type,
      ...(message ? { message } : {}),
      ...(data ? { data } : {})
    };
    await fs.appendFile(this.eventsFilePath(id), `${JSON.stringify(event)}\n`, "utf8");
  }

  async appendLog(id: string, text: string): Promise<void> {
    await fs.appendFile(this.workerLogPath(id), text, "utf8");
  }

  async writeReview(id: string, markdown: string): Promise<void> {
    await fs.writeFile(this.reviewFilePath(id), markdown, "utf8");
  }

  async writePlan(id: string, markdown: string): Promise<void> {
    await fs.writeFile(this.planFilePath(id), markdown, "utf8");
  }

  async readPlan(id: string): Promise<string> {
    return fs.readFile(this.planFilePath(id), "utf8");
  }

  async readReview(id: string): Promise<string> {
    return fs.readFile(this.reviewFilePath(id), "utf8").catch(() => "");
  }

  async readLogTail(id: string, maxChars = 4000): Promise<string> {
    const raw = await fs.readFile(this.workerLogPath(id), "utf8").catch(() => "");
    return raw.length <= maxChars ? raw : raw.slice(-maxChars);
  }

  async updateHeartbeat(id: string, at = new Date().toISOString()): Promise<void> {
    const job = await this.getJob(id);
    if (!job) return;
    job.lastHeartbeatAt = at;
    await this.saveJob(job);
  }

  async updateReviewOutcome(id: string, reviewOutcome: JobReviewOutcome): Promise<JobRecord | null> {
    const job = await this.getJob(id);
    if (!job) return null;
    job.reviewOutcome = reviewOutcome;
    await this.saveJob(job);
    return job;
  }

  async readRecentEvents(id: string, limit = 10): Promise<JobEvent[]> {
    const raw = await fs.readFile(this.eventsFilePath(id), "utf8").catch(() => "");
    const lines = raw.trim().split(/\r?\n/).filter(Boolean).slice(-limit);
    return lines.map((line) => JSON.parse(line) as JobEvent);
  }

  private jobFilePath(id: string): string {
    return path.join(this.jobDir(id), "job.json");
  }

  private eventsFilePath(id: string): string {
    return path.join(this.jobDir(id), "events.jsonl");
  }

  private planFilePath(id: string): string {
    return path.join(this.jobDir(id), "plan.md");
  }

  private reviewFilePath(id: string): string {
    return path.join(this.jobDir(id), "review.md");
  }
}
