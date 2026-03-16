import type { AppConfig } from "../config.js";
import type { SkillDefinition } from "./types.js";

export function createCoreSkills(config: AppConfig): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  if (config.jobs.enabled) {
    skills.push({
      name: "job_orchestration",
      description: "Delegate long-running coding work to a background pi worker, then monitor and review it.",
      instructions: [
        "Use get_current_plan and update_current_plan to maintain a structured plan draft while collaborating with the user.",
        "Before starting a substantial coding job, make sure the plan has a clear title, summary, checklist, and acceptance criteria.",
        "When the plan is ready, prefer delegate_current_plan so the worker receives the exact structured plan you built with the user.",
        "Use background jobs for substantial coding tasks instead of trying to do the entire implementation in the foreground chat loop.",
        "When delegating, create a concrete handoff with a title, summary, checklist, acceptance criteria, allowed scope, out-of-scope items, and review instructions.",
        "Use delegate_job when the user wants implementation work performed in the background.",
        "Use list_jobs or get_job_status when the user asks for progress or status.",
        "Use get_job_log when progress is unclear or the worker may be blocked.",
        "Use review_job when a job is ready for review or when the user asks you to review it.",
        "If review_job returns request_changes, the system may automatically revise the plan and restart the worker. Explain that clearly to the user.",
        "Use approve_job only when the review outcome is clearly acceptable. Use reject_job when the changes should be discarded and the branch reset."
      ].join("\n")
    });
  }

  return skills;
}
