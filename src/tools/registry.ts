import type { AppConfig } from "../config.js";
import type { JobSupervisor } from "../jobs/supervisor.js";
import type { MemoryManager } from "../memory/manager.js";
import type { PlanManager } from "../plans/manager.js";
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
  private readonly pendingApprovals = new Map<string, PendingToolApproval>();
  private nextApprovalId = 1;

  constructor(tools: Tool[]) {
    for (const tool of tools) {
      this.tools.set(tool.definition.name, tool);
    }
  }

  static createBuiltIn(
    config: AppConfig,
    memory: MemoryManager,
    options?: {
      jobs?: JobSupervisor;
      plans?: PlanManager;
      reviewJob?: (jobId: string) => Promise<string>;
      extraTools?: Tool[];
    }
  ): ToolRegistry {
    return new ToolRegistry(createPiTools(config, memory, options));
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
      const pending = this.createPendingApproval(name, args, context);
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
    const values = [...this.pendingApprovals.values()];
    return values
      .filter((entry) => !sessionKey || entry.sessionKey === sessionKey)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async approve(id: string): Promise<ToolExecutionResult & { toolName: string }> {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return { ok: false, toolName: "unknown", content: `No pending approval found for ${id}.` };
    }

    const tool = this.tools.get(pending.toolName);
    if (!tool) {
      this.pendingApprovals.delete(id);
      return { ok: false, toolName: pending.toolName, content: `Tool no longer exists: ${pending.toolName}` };
    }

    this.pendingApprovals.delete(id);
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
    const pending = this.pendingApprovals.get(id) ?? null;
    if (pending) {
      this.pendingApprovals.delete(id);
    }
    return pending;
  }

  private createPendingApproval(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): PendingToolApproval {
    const existing = [...this.pendingApprovals.values()].find((entry) =>
      entry.sessionKey === context.sessionKey &&
      entry.toolName === toolName &&
      JSON.stringify(entry.arguments) === JSON.stringify(args)
    );
    if (existing) {
      return existing;
    }

    const approval: PendingToolApproval = {
      id: String(this.nextApprovalId++),
      sessionKey: context.sessionKey,
      toolName,
      arguments: args,
      requestedAt: new Date().toISOString()
    };
    this.pendingApprovals.set(approval.id, approval);
    return approval;
  }
}
