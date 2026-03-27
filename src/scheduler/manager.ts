import { nextCronOccurrence, parseCronExpression } from "./cron.js";
import type { ScheduledTaskInput, ScheduledTaskRecord } from "./types.js";
import { RuntimeStore } from "../runtime-store/store.js";

export class ScheduledTaskManager {
  constructor(private readonly runtime: RuntimeStore) {}

  createTask(input: ScheduledTaskInput): ScheduledTaskRecord {
    const task = buildScheduledTaskRecord(input);
    const nextRunAt = computeNextRunAt(task, new Date());
    const record: ScheduledTaskRecord = {
      ...task,
      nextRunAt: nextRunAt ?? undefined
    };
    this.runtime.upsertScheduledTask(record);
    return record;
  }

  upsertTask(input: ScheduledTaskInput & { id: string }): ScheduledTaskRecord {
    return this.createTask(input);
  }

  listTasks(): ScheduledTaskRecord[] {
    return this.runtime.listScheduledTasks();
  }

  getTask(id: string): ScheduledTaskRecord | null {
    return this.runtime.getScheduledTask(id);
  }

  pauseTask(id: string): ScheduledTaskRecord | null {
    const task = this.runtime.getScheduledTask(id);
    if (!task) return null;
    const updated: ScheduledTaskRecord = {
      ...task,
      status: "paused",
      updatedAt: new Date().toISOString()
    };
    this.runtime.upsertScheduledTask(updated);
    return updated;
  }

  resumeTask(id: string): ScheduledTaskRecord | null {
    const task = this.runtime.getScheduledTask(id);
    if (!task) return null;
    const updated: ScheduledTaskRecord = {
      ...task,
      status: "active",
      updatedAt: new Date().toISOString(),
      nextRunAt: computeNextRunAt(task, new Date()) ?? undefined
    };
    this.runtime.upsertScheduledTask(updated);
    return updated;
  }

  deleteTask(id: string): boolean {
    const existing = this.runtime.getScheduledTask(id);
    if (!existing) return false;
    this.runtime.deleteScheduledTask(id);
    return true;
  }

  listDueTasks(now = new Date()): ScheduledTaskRecord[] {
    return this.runtime.listDueTasks(now.toISOString());
  }

  recordRunResult(task: ScheduledTaskRecord, params: { status: "ok" | "error"; resultText: string }): ScheduledTaskRecord {
    const now = new Date();
    const nextRunAt = computeNextRunAt(task, now);
    const nextStatus = nextRunAt ? "active" : task.scheduleType === "at" ? "completed" : task.status;
    const updated: ScheduledTaskRecord = {
      ...task,
      status: nextStatus,
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt ?? undefined
    };
    this.runtime.upsertScheduledTask(updated);
    this.runtime.recordTaskRun({
      id: crypto.randomUUID(),
      taskId: task.id,
      status: params.status,
      resultText: params.resultText,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString()
    });
    return updated;
  }
}

export function computeNextRunAt(task: ScheduledTaskRecord | ScheduledTaskInput, from: Date): string | null {
  if (task.scheduleType === "at") {
    if (!task.runAt) {
      throw new Error("scheduleType=at requires runAt.");
    }
    const runAt = new Date(task.runAt);
    if (Number.isNaN(runAt.getTime())) {
      throw new Error(`Invalid runAt timestamp: ${task.runAt}`);
    }
    return runAt.getTime() >= from.getTime() ? runAt.toISOString() : null;
  }

  if (task.scheduleType === "every") {
    if (!task.intervalMs || task.intervalMs <= 0) {
      throw new Error("scheduleType=every requires intervalMs > 0.");
    }
    return new Date(from.getTime() + task.intervalMs).toISOString();
  }

  if (!task.cronExpr?.trim()) {
    throw new Error("scheduleType=cron requires cronExpr.");
  }
  const parsed = parseCronExpression(task.cronExpr);
  return nextCronOccurrence(parsed, from)?.toISOString() ?? null;
}

function buildScheduledTaskRecord(input: ScheduledTaskInput): ScheduledTaskRecord {
  const now = new Date().toISOString();
  return {
    id: input.id ?? crypto.randomUUID(),
    kind: input.kind ?? "prompt",
    agentId: input.agentId,
    sessionTarget: input.sessionTarget,
    scheduleType: input.scheduleType,
    runAt: input.runAt,
    intervalMs: input.intervalMs,
    cronExpr: input.cronExpr,
    prompt: input.prompt,
    deliveryAdapter: input.deliveryAdapter,
    deliveryAddress: input.deliveryAddress,
    status: input.status ?? "active",
    isInternal: input.isInternal ?? false,
    createdAt: now,
    updatedAt: now
  };
}
