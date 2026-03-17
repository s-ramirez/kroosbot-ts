import type { JobSupervisor } from "../jobs/supervisor.js";
import type { JobDelegatePayload } from "../jobs/types.js";
import { type PlanUpdateInput, PlanManager } from "../plans/manager.js";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { optionalString, requiredString } from "./shared.js";

export function createPlanTools(plans: PlanManager, jobs: JobSupervisor): Tool[] {
  return [
    new GetCurrentPlanTool(plans),
    new UpdateCurrentPlanTool(plans),
    new BlockCurrentPlanOnUserTool(plans),
    new ResumeCurrentPlanTool(plans),
    new ClearCurrentPlanTool(plans),
    new DelegateCurrentPlanTool(plans, jobs)
  ];
}

class GetCurrentPlanTool implements Tool {
  readonly definition = {
    name: "get_current_plan",
    description: "Show the current structured plan draft for this chat session.",
    parameters: []
  };

  constructor(private readonly plans: PlanManager) {}

  async execute(_args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    return {
      ok: true,
      content: this.plans.render(context.sessionKey)
    };
  }
}

class UpdateCurrentPlanTool implements Tool {
  readonly definition = {
    name: "update_current_plan",
    description: "Create or refine the current structured plan draft for this chat session.",
    parameters: [
      { name: "title", type: "string" as const, description: "Optional plan title." },
      { name: "summary", type: "string" as const, description: "Optional plan summary." },
      { name: "checklist", type: "string" as const, description: "Optional newline-separated checklist items." },
      { name: "acceptance_criteria", type: "string" as const, description: "Optional newline-separated acceptance criteria." },
      { name: "manual_steps", type: "string" as const, description: "Optional newline-separated user steps that must be completed before implementation can continue." },
      { name: "blocked_on_user", type: "string" as const, description: "Optional true or false override for whether the plan is blocked on user action." },
      { name: "blocked_reason", type: "string" as const, description: "Optional explanation for why the plan is blocked on the user." },
      { name: "allowed_scope", type: "string" as const, description: "Optional newline-separated allowed scope items." },
      { name: "out_of_scope", type: "string" as const, description: "Optional newline-separated out-of-scope items." },
      { name: "check_commands", type: "string" as const, description: "Optional newline-separated validation commands." },
      { name: "review_instructions", type: "string" as const, description: "Optional review guidance." },
      { name: "workspace_dir", type: "string" as const, description: "Optional workspace override for delegation." },
      { name: "provider", type: "string" as const, description: "Optional provider override for the worker." },
      { name: "model", type: "string" as const, description: "Optional model override for the worker." },
      { name: "merge_strategy", type: "string" as const, description: "Use replace or append for list fields. Defaults to replace." }
    ]
  };

  constructor(private readonly plans: PlanManager) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const mergeStrategy = parseMergeStrategy(optionalString(args.merge_strategy));
    const update: PlanUpdateInput = {
      title: optionalString(args.title),
      summary: optionalString(args.summary),
      checklist: splitLines(optionalString(args.checklist)),
      acceptanceCriteria: splitLines(optionalString(args.acceptance_criteria)),
      manualSteps: splitLines(optionalString(args.manual_steps)),
      blockedOnUser: parseOptionalBooleanString(optionalString(args.blocked_on_user), "blocked_on_user"),
      blockedReason: optionalString(args.blocked_reason),
      allowedScope: splitLines(optionalString(args.allowed_scope)),
      outOfScope: splitLines(optionalString(args.out_of_scope)),
      checkCommands: splitLines(optionalString(args.check_commands)),
      reviewInstructions: optionalString(args.review_instructions),
      workspaceDir: optionalString(args.workspace_dir),
      provider: optionalString(args.provider),
      model: optionalString(args.model),
      mergeStrategy
    };
    this.plans.update(context.sessionKey, update);
    return {
      ok: true,
      content: this.plans.render(context.sessionKey)
    };
  }
}

class BlockCurrentPlanOnUserTool implements Tool {
  readonly definition = {
    name: "block_current_plan_on_user",
    description: "Mark the current plan as blocked on the user and record the manual steps still needed.",
    parameters: [
      { name: "reason", type: "string" as const, description: "Why the plan is blocked on the user.", required: true },
      { name: "manual_steps", type: "string" as const, description: "Optional newline-separated manual steps the user must complete." }
    ]
  };

  constructor(private readonly plans: PlanManager) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const next = this.plans.update(context.sessionKey, {
      blockedOnUser: true,
      blockedReason: requiredString(args.reason, "reason"),
      manualSteps: splitLines(optionalString(args.manual_steps)) ?? [],
      mergeStrategy: "replace"
    });
    return {
      ok: true,
      content: renderPlanMessage(context.sessionKey, next)
    };
  }
}

class ResumeCurrentPlanTool implements Tool {
  readonly definition = {
    name: "resume_current_plan",
    description: "Mark the current plan as unblocked after the user completes any required manual setup.",
    parameters: [
      { name: "note", type: "string" as const, description: "Optional short note about what changed before resuming." }
    ]
  };

  constructor(private readonly plans: PlanManager) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const note = optionalString(args.note);
    const next = this.plans.update(context.sessionKey, {
      blockedOnUser: false,
      blockedReason: note ? `Resumed: ${note}` : undefined,
      manualSteps: [],
      mergeStrategy: "replace"
    });
    return {
      ok: true,
      content: renderPlanMessage(context.sessionKey, next)
    };
  }
}

class ClearCurrentPlanTool implements Tool {
  readonly definition = {
    name: "clear_current_plan",
    description: "Clear the current structured plan draft for this chat session.",
    parameters: []
  };

  constructor(private readonly plans: PlanManager) {}

  async execute(_args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.plans.clear(context.sessionKey);
    return {
      ok: true,
      content: "Cleared the current plan for this session."
    };
  }
}

class DelegateCurrentPlanTool implements Tool {
  readonly definition = {
    name: "delegate_current_plan",
    description: "Delegate the current structured plan draft as a background coding job.",
    parameters: []
  };

  constructor(
    private readonly plans: PlanManager,
    private readonly jobs: JobSupervisor
  ) {}

  async execute(_args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const plan = this.plans.get(context.sessionKey);
    if (!plan) {
      return { ok: false, content: "No current plan exists for this session. Build one first with update_current_plan." };
    }

    const missing: string[] = [];
    if (!plan.title?.trim()) missing.push("title");
    if (!plan.summary?.trim()) missing.push("summary");
    if (plan.acceptanceCriteria.length === 0) missing.push("acceptance criteria");
    if (plan.checklist.length === 0) missing.push("checklist");
    if (plan.blockedOnUser) missing.push("plan is blocked on user action");
    if (plan.manualSteps.length > 0) missing.push("manual steps still pending");
    if (missing.length > 0) {
      return {
        ok: false,
        content: `Current plan is not ready to delegate. Missing: ${missing.join(", ")}.`
      };
    }

    const payload: JobDelegatePayload = {
      title: requiredString(plan.title, "title"),
      summary: requiredString(plan.summary, "summary"),
      checklist: [...plan.checklist],
      acceptanceCriteria: [...plan.acceptanceCriteria],
      allowedScope: [...plan.allowedScope],
      outOfScope: [...plan.outOfScope],
      checkCommands: [...plan.checkCommands],
      reviewInstructions: plan.reviewInstructions,
      workspaceDir: plan.workspaceDir,
      provider: plan.provider,
      model: plan.model
    };
    const job = await this.jobs.createAndStartJob(payload, context.sessionKey);
    return {
      ok: true,
      content: `Delegated current plan as background job ${job.id} on branch ${job.jobBranch}.`
    };
  }
}

function splitLines(value?: string): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, ""));
}

function parseMergeStrategy(value?: string): "replace" | "append" {
  return value?.trim().toLowerCase() === "append" ? "append" : "replace";
}

function parseOptionalBooleanString(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

function renderPlanMessage(sessionKey: string, plan: ReturnType<PlanManager["update"]>): string {
  return [
    `Updated current plan for ${sessionKey}.`,
    "",
    [
      `Title: ${plan.title ?? "(missing)"}`,
      `Summary: ${plan.summary ?? "(missing)"}`,
      `Blocked on user: ${plan.blockedOnUser ? "yes" : "no"}`,
      `Blocked reason: ${plan.blockedReason ?? "(none)"}`,
      "Manual steps:",
      plan.manualSteps.length > 0 ? plan.manualSteps.map((item) => `- ${item}`).join("\n") : "- (none)"
    ].join("\n")
  ].join("\n");
}
