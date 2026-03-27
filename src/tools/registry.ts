import type { SubagentManager } from "../agents/manager.js";
import type { AppConfig } from "../config.js";
import type { JobSupervisor } from "../jobs/supervisor.js";
import type { MemoryManager } from "../memory/manager.js";
import type { PlanManager } from "../plans/manager.js";
import type { RuntimeStore } from "../runtime-store/store.js";
import { createPiTools } from "./piTools.js";
import type {
  PendingToolApproval,
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult
} from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(
    tools: Tool[],
    private readonly runtime: RuntimeStore
  ) {
    for (const tool of tools) {
      this.tools.set(tool.definition.name, tool);
    }
  }

  static createBuiltIn(
    config: AppConfig,
    memory: MemoryManager,
    options: {
      jobs?: JobSupervisor;
      plans?: PlanManager;
      runtime: RuntimeStore;
      sendSessionMessage?: (params: { sessionKey: string; text: string; sourceSessionKey: string }) => Promise<void>;
      reviewJob?: (jobId: string) => Promise<string>;
      getLoadedSkillNames?: () => string[];
      reloadRuntime?: () => Promise<void>;
      agents?: SubagentManager;
      extraTools?: Tool[];
    }
  ): ToolRegistry {
    return new ToolRegistry(createPiTools(config, memory, options), options.runtime);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, content: `Unknown tool: ${name}` };
    }

    if ((tool.definition.approvalMode ?? "none") === "always") {
      const pending = this.runtime.createApproval({
        sessionKey: context.sessionKey,
        toolName: name,
        arguments: args
      });
      return {
        ok: false,
        requiresApproval: true,
        approvalId: pending.id,
        content: `Approval required. Pending request ${pending.id} for ${name}. Ask the user to run /approve ${pending.id} or /deny ${pending.id}.`
      };
    }

    try {
      return await tool.execute(args, context);
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error)
      };
    }
  }

  listPendingApprovals(sessionKey?: string): PendingToolApproval[] {
    return this.runtime.listPendingApprovals(sessionKey);
  }

  async approve(id: string): Promise<ToolExecutionResult & { toolName: string }> {
    const pending = this.runtime.resolveApproval(id, "approved");
    if (!pending) {
      return { ok: false, toolName: "unknown", content: `No pending approval found for ${id}.` };
    }

    const tool = this.tools.get(pending.toolName);
    if (!tool) {
      this.runtime.resolveApproval(id, "expired");
      return { ok: false, toolName: pending.toolName, content: `Tool no longer exists: ${pending.toolName}` };
    }

    try {
      const result = await tool.execute(pending.arguments, { sessionKey: pending.sessionKey });
      return { ...result, toolName: pending.toolName };
    } catch (error) {
      return {
        ok: false,
        toolName: pending.toolName,
        content: error instanceof Error ? error.message : String(error)
      };
    }
  }

  deny(id: string): PendingToolApproval | null {
    return this.runtime.resolveApproval(id, "denied");
  }
}
