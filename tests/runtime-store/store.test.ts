import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RuntimeStore } from "../../src/runtime-store/store.js";
import { SessionKey } from "../../src/store.js";
import { createTempRuntimeStore } from "../helpers/runtime.js";

describe("RuntimeStore", () => {
  let runtime: RuntimeStore;
  let dbPath: string;
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const setup = await createTempRuntimeStore(50);
    runtime = setup.runtime;
    dbPath = setup.dbPath;
    cleanup = setup.cleanup;
  });

  afterEach(async () => {
    await cleanup?.();
  });

  test("bootstraps the schema", () => {
    const db = new Database(dbPath, { readonly: true, create: false });
    const tables = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'table' and name in ('sessions', 'messages', 'approvals', 'scheduled_tasks') order by name"
      )
      .all()
      .map((row) => row.name);
    db.close();

    expect(tables).toEqual(["approvals", "messages", "scheduled_tasks", "sessions"]);
  });

  test("upserts sessions and preserves chronological message history", () => {
    const sessionKey = SessionKey.direct("discord", "user-1");
    runtime.appendInboundMessage({
      adapter: "discord",
      chatKind: "direct",
      messageId: "msg-1",
      sessionKey,
      conversationId: "dm-user-1",
      deliveryTarget: {
        adapter: "discord",
        address: "channel:123"
      },
      senderId: "user-1",
      senderName: "User One",
      text: "hello"
    });
    runtime.appendAssistantMessage(sessionKey, "hi");
    runtime.appendInboundMessage({
      adapter: "discord",
      chatKind: "direct",
      messageId: "msg-2",
      sessionKey,
      conversationId: "dm-user-1",
      deliveryTarget: {
        adapter: "discord",
        address: "channel:456"
      },
      senderId: "user-1",
      senderName: "User One",
      text: "follow up"
    });

    const sessions = runtime.listSessions(10);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.key.toString()).toBe(sessionKey.toString());
    expect(sessions[0]?.lastDelivery.address).toBe("channel:456");

    const history = runtime.historyForSessionKey(sessionKey.toString(), 10);
    expect(history.turns.map((turn) => `${turn.role}:${turn.text}`)).toEqual([
      "user:hello",
      "assistant:hi",
      "user:follow up"
    ]);
  });

  test("persists approvals across reopen and resolves them", () => {
    const sessionKey = "approval:test";
    const approval = runtime.createApproval({
      sessionKey,
      toolName: "send_message",
      arguments: { text: "hello" }
    });
    runtime.close();

    runtime = new RuntimeStore({ enabled: true, dbPath }, 50);
    runtime.initialize();

    const pending = runtime.listPendingApprovals(sessionKey);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(approval.id);

    const resolved = runtime.resolveApproval(approval.id, "approved");
    expect(resolved?.toolName).toBe("send_message");
    expect(runtime.listPendingApprovals(sessionKey)).toHaveLength(0);
  });

  test("stores plans and scheduled tasks", () => {
    const sessionKey = "plan:test";
    runtime.updatePlan(sessionKey, {
      title: "Ship it",
      checklist: ["add tests", "run build"],
      acceptanceCriteria: ["all tests pass"],
      mergeStrategy: "replace"
    });

    const plan = runtime.getPlan(sessionKey);
    expect(plan?.title).toBe("Ship it");
    expect(plan?.checklist).toEqual(["add tests", "run build"]);

    runtime.createScheduledTask({
      id: "task-1",
      kind: "prompt",
      sessionTarget: `session:${sessionKey}`,
      scheduleType: "at",
      runAt: "2026-03-26T10:00:00.000Z",
      prompt: "remind me",
      status: "active",
      isInternal: false,
      createdAt: "2026-03-26T09:59:00.000Z",
      updatedAt: "2026-03-26T09:59:00.000Z",
      nextRunAt: "2026-03-26T10:00:00.000Z"
    });

    const due = runtime.listDueTasks("2026-03-26T10:00:00.000Z");
    expect(due.map((task) => task.id)).toEqual(["task-1"]);
  });
});
