import path from "node:path";
import type { AppConfig } from "../config.js";
import type { JobSupervisor } from "../jobs/supervisor.js";
import type { MemoryManager } from "../memory/manager.js";
import type { PlanManager } from "../plans/manager.js";
import type { Tool } from "./types.js";
import { createCodingTools } from "./codingTools.js";
import { createJobTools } from "./jobTools.js";
import { createMemoryTools } from "./memoryTools.js";
import { createPlanTools } from "./planTools.js";

export function createPiTools(
  config: AppConfig,
  memory: MemoryManager,
  options?: {
    jobs?: JobSupervisor;
    plans?: PlanManager;
    reviewJob?: (jobId: string) => Promise<string>;
    extraTools?: Tool[];
  }
): Tool[] {
  const workspaceDir = path.resolve(config.app.workspaceDir);
  return [
    ...createMemoryTools(memory),
    ...createCodingTools(workspaceDir),
    ...(config.jobs.enabled && options?.jobs && options.plans
      ? createPlanTools(options.plans, options.jobs)
      : []),
    ...(config.jobs.enabled && options?.jobs && options.reviewJob
      ? createJobTools(options.jobs, { reviewJob: options.reviewJob })
      : []),
    ...(options?.extraTools ?? [])
  ];
}
