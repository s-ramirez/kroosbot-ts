import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { computeNextRunAt, ScheduledTaskManager } from "../../src/scheduler/manager.js";
import type { ScheduledTaskRecord } from "../../src/scheduler/types.js";
import { createTempRuntimeStore } from "../helpers/runtime.js";

describe("ScheduledTaskManager", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let manager: ScheduledTaskManager;

  beforeEach(async () => {
    const setup = await createTempRuntimeStore();
    cleanup = setup.cleanup;
    manager = new ScheduledTaskManager(setup.runtime);
  });

  afterEach(async () => {
    await cleanup?.();
  });

  test("computes next run for at/every/cron schedules", () => {
    expect(
      computeNextRunAt(
        {
          id: "at-task",
          kind: "prompt",
          sessionTarget: "session:test",
          scheduleType: "at",
          runAt: "2026-03-26T10:30:00.000Z",
          prompt: "hello",
          status: "active",
          isInternal: false,
          createdAt: "2026-03-26T10:00:00.000Z",
          updatedAt: "2026-03-26T10:00:00.000Z"
        },
        new Date("2026-03-26T10:00:00.000Z")
      )
    ).toBe("2026-03-26T10:30:00.000Z");

    expect(
      computeNextRunAt(
        {
          id: "every-task",
          kind: "prompt",
          sessionTarget: "session:test",
          scheduleType: "every",
          intervalMs: 60_000,
          prompt: "hello",
          status: "active",
          isInternal: false,
          createdAt: "2026-03-26T10:00:00.000Z",
          updatedAt: "2026-03-26T10:00:00.000Z"
        },
        new Date("2026-03-26T10:00:00.000Z")
      )
    ).toBe("2026-03-26T10:01:00.000Z");

    expect(
      computeNextRunAt(
        {
          id: "cron-task",
          kind: "prompt",
          sessionTarget: "session:test",
          scheduleType: "cron",
          cronExpr: "*/5 * * * *",
          prompt: "hello",
          status: "active",
          isInternal: false,
          createdAt: "2026-03-26T10:00:00.000Z",
          updatedAt: "2026-03-26T10:00:00.000Z"
        },
        new Date("2026-03-26T10:02:00.000Z")
      )
    ).toBe("2026-03-26T10:05:00.000Z");
  });

  test("creates, pauses, resumes, and deletes tasks", () => {
    const created = manager.createTask({
      kind: "prompt",
      sessionTarget: "session:test",
      scheduleType: "cron",
      cronExpr: "*/10 * * * *",
      prompt: "check in"
    });

    expect(manager.listTasks()).toHaveLength(1);
    expect(created.nextRunAt).toBeDefined();

    const paused = manager.pauseTask(created.id);
    expect(paused?.status).toBe("paused");

    const resumed = manager.resumeTask(created.id);
    expect(resumed?.status).toBe("active");
    expect(resumed?.nextRunAt).toBeDefined();

    expect(manager.deleteTask(created.id)).toBe(true);
    expect(manager.listTasks()).toHaveLength(0);
  });

  test("records runs and completes one-shot tasks", () => {
    const task = manager.createTask({
      id: "one-shot",
      kind: "prompt",
      sessionTarget: "session:test",
      scheduleType: "at",
      runAt: "2000-01-01T00:00:00.000Z",
      prompt: "do it"
    });

    const updated = manager.recordRunResult(task, {
      status: "ok",
      resultText: "done"
    });

    expect(updated.status).toBe("completed");
    expect(updated.nextRunAt).toBeUndefined();
    expect(manager.getTask("one-shot")?.status).toBe("completed");
  });

  test("keeps recurring tasks active after a run", () => {
    const task = manager.createTask({
      id: "recurring",
      kind: "prompt",
      sessionTarget: "session:test",
      scheduleType: "every",
      intervalMs: 10_000,
      prompt: "repeat"
    });

    const updated = manager.recordRunResult(task, {
      status: "ok",
      resultText: "ran"
    });

    expect(updated.status).toBe("active");
    expect(updated.nextRunAt).toBeDefined();
    expect(manager.getTask("recurring")?.status).toBe("active");
  });
});
