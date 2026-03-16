import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { JobSupervisor } from "../jobs/supervisor.js";
import type { MemoryManager } from "../memory/manager.js";
import type { PlanManager } from "../plans/manager.js";
import type { LoadedSkill, SkillHandlerContext, SkillManifest, SkillModule } from "./types.js";

const skillManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  enabled: z.boolean().default(true),
  entry: z.string().optional()
});

export async function loadWorkspaceSkills(params: {
  config: AppConfig;
  memory: MemoryManager;
  jobs: JobSupervisor;
  plans: PlanManager;
  reviewJob: (jobId: string) => Promise<string>;
}): Promise<LoadedSkill[]> {
  const workspaceDir = path.resolve(params.config.app.workspaceDir);
  const skillsRoot = path.join(workspaceDir, "skills");
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const loaded: LoadedSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const skill = await loadSingleSkill({
      skillDir,
      workspaceDir,
      config: params.config,
      memory: params.memory,
      jobs: params.jobs,
      plans: params.plans,
      reviewJob: params.reviewJob
    }).catch((error) => {
      console.warn("failed to load workspace skill", {
        skillDir,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    });
    if (skill) {
      loaded.push(skill);
    }
  }

  return loaded;
}

async function loadSingleSkill(params: {
  skillDir: string;
  workspaceDir: string;
  config: AppConfig;
  memory: MemoryManager;
  jobs: JobSupervisor;
  plans: PlanManager;
  reviewJob: (jobId: string) => Promise<string>;
}): Promise<LoadedSkill | null> {
  const manifestPath = path.join(params.skillDir, "skill.json");
  const skillMdPath = path.join(params.skillDir, "SKILL.md");
  const manifestRaw = await fs.readFile(manifestPath, "utf8").catch(() => null);
  if (!manifestRaw) return null;

  const manifest = skillManifestSchema.parse(JSON.parse(manifestRaw) as SkillManifest);
  if (manifest.enabled === false) {
    return null;
  }

  const skillMarkdown = (await fs.readFile(skillMdPath, "utf8").catch(() => "")).trim();
  const moduleResult = manifest.entry
    ? await loadSkillModule(manifest.entry, {
        config: params.config,
        memory: params.memory,
        jobs: params.jobs,
        plans: params.plans,
        reviewJob: params.reviewJob,
        workspaceDir: params.workspaceDir,
        skillDir: params.skillDir
      }, params.skillDir)
    : null;

  return {
    definition: {
      name: manifest.name,
      description: moduleResult?.description?.trim() || manifest.description,
      instructions: [skillMarkdown, moduleResult?.instructions?.trim()]
        .filter(Boolean)
        .join("\n\n")
    },
    tools: moduleResult?.tools ?? []
  };
}

async function loadSkillModule(
  entry: string,
  context: SkillHandlerContext,
  skillDir: string
) {
  const resolved = path.resolve(skillDir, entry);
  const module = (await import(pathToFileURL(resolved).href)) as SkillModule;
  if (typeof module.registerSkill !== "function") {
    throw new Error(`Skill module does not export registerSkill(): ${resolved}`);
  }
  return module.registerSkill(context);
}
