import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SessionKey } from "../../src/store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createSessionTools } from "../../src/tools/sessionTools.js";
import { createTempRuntimeStore } from "../helpers/runtime.js";

describe("session tools", () => {
  let runtime: Awaited<ReturnType<typeof createTempRuntimeStore>>["runtime"];
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const setup = await createTempRuntimeStore();
    runtime = setup.runtime;
    cleanup = setup.cleanup;

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
    runtime.appendAssistantMessage(sessionKey, "hi there");
  });

  afterEach(async () => {
    await cleanup?.();
  });

  test("lists recent sessions", async () => {
    const registry = new ToolRegistry(createSessionTools(runtime), runtime);
    const result = await registry.execute("list_sessions", {}, { sessionKey: "discord:direct:user-1" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("discord:direct:user-1");
    expect(result.content).toContain("channel:123");
  });

  test("returns session history for the current session by default", async () => {
    const registry = new ToolRegistry(createSessionTools(runtime), runtime);
    const result = await registry.execute("session_history", { limit: "5" }, { sessionKey: "discord:direct:user-1" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1. user: hello");
    expect(result.content).toContain("2. assistant: hi there");
  });

  test("requires approval before send_message runs", async () => {
    const sendMessage = mock(async () => undefined);
    const registry = new ToolRegistry(createSessionTools(runtime, { sendMessage }), runtime);
    const result = await registry.execute(
      "send_message",
      { session_key: "discord:direct:user-1", text: "Checking in" },
      { sessionKey: "discord:direct:user-1" }
    );

    expect(result.ok).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();

    const pending = runtime.listPendingApprovals("discord:direct:user-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe("send_message");
  });
});
