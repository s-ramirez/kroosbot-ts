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
  private readonly plans = new Map<string, SessionPlan>();

  get(sessionKey: string): SessionPlan | null {
    return this.plans.get(sessionKey) ?? null;
  }

  clear(sessionKey: string): void {
    this.plans.delete(sessionKey);
  }

  update(sessionKey: string, input: PlanUpdateInput): SessionPlan {
    const existing = this.get(sessionKey) ?? createEmptyPlan();
    const mergeStrategy = input.mergeStrategy ?? "replace";
    const next: SessionPlan = {
      ...existing,
      updatedAt: new Date().toISOString()
    };

    if (input.title !== undefined) next.title = input.title;
    if (input.summary !== undefined) next.summary = input.summary;
    if (input.reviewInstructions !== undefined) next.reviewInstructions = input.reviewInstructions;
    if (input.workspaceDir !== undefined) next.workspaceDir = input.workspaceDir;
    if (input.provider !== undefined) next.provider = input.provider;
    if (input.model !== undefined) next.model = input.model;
    if (input.blockedOnUser !== undefined) next.blockedOnUser = input.blockedOnUser;
    if (input.blockedReason !== undefined) next.blockedReason = input.blockedReason;

    if (input.checklist !== undefined) {
      next.checklist = mergeList(existing.checklist, input.checklist, mergeStrategy);
    }
    if (input.acceptanceCriteria !== undefined) {
      next.acceptanceCriteria = mergeList(existing.acceptanceCriteria, input.acceptanceCriteria, mergeStrategy);
    }
    if (input.manualSteps !== undefined) {
      next.manualSteps = mergeList(existing.manualSteps, input.manualSteps, mergeStrategy);
    }
    if (input.allowedScope !== undefined) {
      next.allowedScope = mergeList(existing.allowedScope, input.allowedScope, mergeStrategy);
    }
    if (input.outOfScope !== undefined) {
      next.outOfScope = mergeList(existing.outOfScope, input.outOfScope, mergeStrategy);
    }
    if (input.checkCommands !== undefined) {
      next.checkCommands = mergeList(existing.checkCommands, input.checkCommands, mergeStrategy);
    }

    this.plans.set(sessionKey, next);
    return next;
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

function createEmptyPlan(): SessionPlan {
  return {
    checklist: [],
    acceptanceCriteria: [],
    manualSteps: [],
    blockedOnUser: false,
    allowedScope: [],
    outOfScope: [],
    checkCommands: []
  };
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

function mergeList(existing: string[], incoming: string[], strategy: "replace" | "append"): string[] {
  if (strategy === "replace") {
    return dedupe(incoming);
  }
  return dedupe([...existing, ...incoming]);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function renderList(values: string[]): string {
  return values.length > 0 ? values.map((item) => `- ${item}`).join("\n") : "- (none)";
}
