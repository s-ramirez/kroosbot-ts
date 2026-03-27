import path from "node:path";
import type { SubagentManager } from "../agents/manager.js";
import type { AppConfig } from "../config.js";
import type { JobSupervisor } from "../jobs/supervisor.js";
import type { MemoryManager } from "../memory/manager.js";
import type { PlanManager } from "../plans/manager.js";
import type { RuntimeStore } from "../runtime-store/store.js";
import type { Tool } from "./types.js";
import { createAgentTools } from "./agentTools.js";
import { createCodingTools } from "./codingTools.js";
import { createJobTools } from "./jobTools.js";
import { createMemoryTools } from "./memoryTools.js";
import { createPlanTools } from "./planTools.js";
import { createSessionTools } from "./sessionTools.js";
import { createSkillTools } from "./skillTools.js";

export function createPiTools(
  config: AppConfig,
  memory: MemoryManager,
  options?: {
    jobs?: JobSupervisor;
    plans?: PlanManager;
    runtime?: RuntimeStore;
    sendSessionMessage?: (params: { sessionKey: string; text: string; sourceSessionKey: string }) => Promise<void>;
    reviewJob?: (jobId: string) => Promise<string>;
    getLoadedSkillNames?: () => string[];
    reloadRuntime?: () => Promise<void>;
    agents?: SubagentManager;
    extraTools?: Tool[];
  }
): Tool[] {
  const workspaceDir = path.resolve(config.app.workspaceDir);
  return [
    ...createMemoryTools(memory),
    ...(options?.runtime ? createSessionTools(options.runtime, { sendMessage: options.sendSessionMessage }) : []),
    ...createCodingTools(workspaceDir),
    ...createSkillTools(workspaceDir, {
      getLoadedSkillNames: options?.getLoadedSkillNames,
      reloadRuntime: options?.reloadRuntime
    }),
    ...(config.jobs.enabled && options?.jobs && options.plans
      ? createPlanTools(options.plans, options.jobs)
      : []),
    ...(config.jobs.enabled && options?.jobs && options.reviewJob
      ? createJobTools(options.jobs, { reviewJob: options.reviewJob, agents: options.agents })
      : []),
    ...(options?.agents ? createAgentTools(options.agents) : []),
    ...(options?.extraTools ?? [])
  ];
}
