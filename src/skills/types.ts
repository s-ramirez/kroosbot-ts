import type { AppConfig } from "../config.js";
import type { JobSupervisor } from "../jobs/supervisor.js";
import type { MemoryManager } from "../memory/manager.js";
import type { PlanManager } from "../plans/manager.js";
import type { Tool } from "../tools/types.js";

export type SkillDefinition = {
  name: string;
  description: string;
  instructions: string;
};

export type SkillManifest = {
  name: string;
  description: string;
  enabled?: boolean;
  entry?: string;
};

export type LoadedSkill = {
  definition: SkillDefinition;
  tools: Tool[];
};

export type SkillHandlerContext = {
  config: AppConfig;
  memory: MemoryManager;
  jobs: JobSupervisor;
  plans: PlanManager;
  reviewJob: (jobId: string) => Promise<string>;
  workspaceDir: string;
  skillDir: string;
};

export type SkillModuleResult = {
  description?: string;
  instructions?: string;
  tools?: Tool[];
};

export type SkillModule = {
  registerSkill?: (context: SkillHandlerContext) => Promise<SkillModuleResult> | SkillModuleResult;
};
