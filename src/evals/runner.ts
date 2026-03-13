import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../config.js";
import { OpenAiCompatibleBrain } from "../brain/openaiCompatible.js";
import type { ToolTraceEvent } from "../brain/types.js";
import { MemoryManager } from "../memory/manager.js";
import { SessionKey, type ChatHistory, type InboundMessage } from "../store.js";
import { ToolRegistry } from "../tools/registry.js";
import { evalSuiteSchema, type EvalCaseResult, type EvalSuite } from "./types.js";

export async function runEvalSuite(suitePath: string): Promise<{
  suite: EvalSuite;
  results: EvalCaseResult[];
}> {
  const raw = await fs.readFile(suitePath, "utf8");
  const suite = evalSuiteSchema.parse(JSON.parse(raw) as unknown);
  const results: EvalCaseResult[] = [];

  for (const testCase of suite.cases) {
    results.push(await runEvalCase(loadConfig(), testCase));
  }

  return { suite, results };
}

async function runEvalCase(config: AppConfig, testCase: EvalSuite["cases"][number]): Promise<EvalCaseResult> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kroosbot-eval-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const memoryDir = path.join(tempRoot, "memory");
  const memoryIndexFile = path.join(tempRoot, "MEMORY.md");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(memoryDir, { recursive: true });

  try {
    for (const file of testCase.workspaceFiles) {
      const targetPath = path.join(workspaceDir, file.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.content, "utf8");
    }

    const evalConfig = buildEvalConfig(config, {
      workspaceDir,
      memoryDir,
      memoryIndexFile
    });
    const memory = new MemoryManager(evalConfig.memory);
    await memory.initialize();
    for (const note of testCase.memoryNotes) {
      await memory.appendNote({ text: note.text, category: note.category });
    }

    const toolTrace: ToolTraceEvent[] = [];
    const tools = ToolRegistry.createBuiltIn(evalConfig, memory);
    const brain = new OpenAiCompatibleBrain(
      evalConfig.brain,
      memory,
      tools,
      (event) => toolTrace.push(event)
    );

    const sessionKey = SessionKey.direct("discord", "eval-user");
    const message: InboundMessage = {
      adapter: "discord",
      chatKind: "direct",
      messageId: `eval-${testCase.name}`,
      sessionKey,
      conversationId: "eval-conversation",
      deliveryTarget: {
        adapter: "discord",
        address: "eval-discord-user"
      },
      senderId: "eval-user",
      senderName: "Eval User",
      text: testCase.input
    };

    const history: ChatHistory = { turns: testCase.history };
    const outbound = await brain.reply(message, history);
    const finalAnswer = outbound?.text ?? "";
    const calledTools = [...new Set(toolTrace.map((entry) => entry.toolName))];
    const failures = evaluateExpectations(testCase, finalAnswer, calledTools);

    return {
      name: testCase.name,
      passed: failures.length === 0,
      failures,
      finalAnswer,
      calledTools,
      trace: toolTrace.map((entry) => ({
        step: entry.step,
        toolName: entry.toolName,
        ok: entry.ok,
        requiresApproval: entry.requiresApproval,
        approvalId: entry.approvalId,
        arguments: entry.arguments,
        content: entry.content
      }))
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function buildEvalConfig(
  base: AppConfig,
  paths: { workspaceDir: string; memoryDir: string; memoryIndexFile: string }
): AppConfig {
  return {
    ...base,
    app: {
      ...base.app,
      workspaceDir: paths.workspaceDir
    },
    memory: {
      ...base.memory,
      rootDir: paths.memoryDir,
      indexFile: paths.memoryIndexFile
    }
  };
}

function evaluateExpectations(
  testCase: EvalSuite["cases"][number],
  finalAnswer: string,
  calledTools: string[]
): string[] {
  const failures: string[] = [];
  const expected = testCase.expected;

  for (const name of expected.mustCallAll) {
    if (!calledTools.includes(name)) {
      failures.push(`Expected tool call missing: ${name}`);
    }
  }

  if (expected.mustCallAnyOf.length > 0 && !expected.mustCallAnyOf.some((name) => calledTools.includes(name))) {
    failures.push(`Expected at least one of these tool calls: ${expected.mustCallAnyOf.join(", ")}`);
  }

  for (const name of expected.mustNotCall) {
    if (calledTools.includes(name)) {
      failures.push(`Unexpected tool call present: ${name}`);
    }
  }

  const lowerFinal = finalAnswer.toLowerCase();
  for (const needle of expected.finalAnswerContains) {
    if (!lowerFinal.includes(needle.toLowerCase())) {
      failures.push(`Final answer missing text: ${needle}`);
    }
  }

  for (const needle of expected.finalAnswerNotContains) {
    if (lowerFinal.includes(needle.toLowerCase())) {
      failures.push(`Final answer unexpectedly included text: ${needle}`);
    }
  }

  return failures;
}
