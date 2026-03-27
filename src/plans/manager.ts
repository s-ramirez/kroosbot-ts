import { RuntimeStore } from "../runtime-store/store.js";

export type SessionPlan = {
  title?: string;
  summary?: string;
  checklist: string[];
  acceptanceCriteria: string[];
  manualSteps: string[];
  blockedOnUser: boolean;
  blockedReason?: string;
  allowedScope: string[];
  outOfScope: string[];
  checkCommands: string[];
  reviewInstructions?: string;
  workspaceDir?: string;
  provider?: string;
  model?: string;
  updatedAt?: string;
};

export type PlanUpdateInput = {
  title?: string;
  summary?: string;
  checklist?: string[];
  acceptanceCriteria?: string[];
  manualSteps?: string[];
  blockedOnUser?: boolean;
  blockedReason?: string;
  allowedScope?: string[];
  outOfScope?: string[];
  checkCommands?: string[];
  reviewInstructions?: string;
  workspaceDir?: string;
  provider?: string;
  model?: string;
  mergeStrategy?: "replace" | "append";
};

export class PlanManager {
  constructor(private readonly runtime: RuntimeStore) {}

  get(sessionKey: string): SessionPlan | null {
    return this.runtime.getPlan(sessionKey);
  }

  clear(sessionKey: string): void {
    this.runtime.clearPlan(sessionKey);
  }

  update(sessionKey: string, input: PlanUpdateInput): SessionPlan {
    return this.runtime.updatePlan(sessionKey, input);
  }

  render(sessionKey: string): string {
    const plan = this.get(sessionKey);
    if (!plan) {
      return "No current plan for this session.";
    }

    return [
      `Current plan for ${sessionKey}:`,
      "",
      `Status: ${describePlanStatus(plan)}`,
      `Blocked reason: ${plan.blockedReason ?? "(none)"}`,
      `Title: ${plan.title ?? "(missing)"}`,
      `Summary: ${plan.summary ?? "(missing)"}`,
      `Workspace: ${plan.workspaceDir ?? "(default workspace)"}`,
      `Runtime override: ${plan.provider ?? "(default provider)"}/${plan.model ?? "(default model)"}`,
      "",
      "Checklist:",
      renderList(plan.checklist),
      "",
      "Acceptance criteria:",
      renderList(plan.acceptanceCriteria),
      "",
      "Manual steps:",
      renderList(plan.manualSteps),
      "",
      "Allowed scope:",
      renderList(plan.allowedScope),
      "",
      "Out of scope:",
      renderList(plan.outOfScope),
      "",
      "Check commands:",
      renderList(plan.checkCommands),
      "",
      `Review instructions: ${plan.reviewInstructions ?? "(none)"}`,
      `Updated: ${plan.updatedAt ?? "unknown"}`
    ].join("\n");
  }
}

function describePlanStatus(plan: SessionPlan): string {
  if (plan.blockedOnUser || plan.manualSteps.length > 0) {
    return "blocked_on_user";
  }
  if (!plan.title?.trim() || !plan.summary?.trim() || plan.checklist.length === 0 || plan.acceptanceCriteria.length === 0) {
    return "draft";
  }
  return "ready_to_delegate";
}

function renderList(values: string[]): string {
  return values.length > 0 ? values.map((item) => `- ${item}`).join("\n") : "- (none)";
}
