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
        "For capability requests that need user setup, use block_current_plan_on_user so the plan has an explicit blocked state instead of silently stalling.",
        "Before starting a substantial coding job, make sure the plan has a clear title, summary, checklist, and acceptance criteria.",
        "If the work depends on a manual install or other user action, record that in manual_steps and do not delegate until the user confirms it is done.",
        "When the user confirms the setup is finished, use resume_current_plan before delegating.",
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

  skills.push({
    name: "capability_expansion",
    description: "Turn user requests for new Kroosbot abilities into the right skill, core feature, or integration workflow.",
    instructions: [
      "Treat the user as the source of new capability ideas. Collaborate with them on behavior and constraints before implementing.",
      "For new capability requests, build or refresh the current plan before doing broad repo exploration.",
      "When the user asks Kroosbot to gain a new ability, first classify the request as one of: workspace skill, core app feature, adapter extension, or external integration.",
      "Use list_skills to inspect the current workspace skill surface before assuming a capability already exists.",
      "If a lightweight workspace skill is the right fit, use create_skill_scaffold to create a new skill package instead of wandering the repo.",
      "Use the plan tools to capture the implementation shape before delegating larger work. If manual install steps are needed, store them in manual_steps, mark the plan blocked with block_current_plan_on_user, and ask the user to do them.",
      "When the user says the manual setup is complete, use resume_current_plan to clear the blocked state and continue.",
      "Kroosbot should not assume it can run system package managers or other host-level installers. If a capability needs brew, uv, pip, model downloads, or external setup, ask the user explicitly.",
      "If the request clearly needs core app changes, adapter changes, or external service wiring, say that plainly and prefer building a concrete plan or background job handoff.",
      "Be explicit about install requirements, approval requirements, restart requirements, and validation steps.",
      "Do not keep exploring with generic file tools once you already know the correct extension path."
    ].join("\n")
  });

  if (config.agents.enabled) {
    skills.push({
      name: "agent_orchestration",
      description: "Create, manage, and switch between named AI agents with different models and personalities.",
      instructions: [
        "When the user asks to create a specialized agent, use create_agent with a descriptive name and the requested model.",
        "The model parameter should be the model identifier (e.g. 'claude-opus-4-6', 'deepseek/deepseek-r1-0528-qwen3-8b').",
        "If the user describes a personality for the agent, pass it as the personality parameter to give the agent a custom SOUL.",
        "Use switch_agent to change which agent handles the current conversation. Use 'default' to switch back to the main brain.",
        "Use list_agents to show available agents when asked.",
        "Each agent has its own memory namespace, so information stored by one agent is not visible to others.",
        "When creating an agent, the brain_mode defaults to the main brain's mode. Use 'agent-sdk' for Claude models or 'openai-compatible' for other providers."
      ].join("\n")
    });
  }

  return skills;
}
