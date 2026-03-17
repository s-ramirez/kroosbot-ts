import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { optionalString, requiredString } from "./shared.js";

export function createSkillTools(
  workspaceDir: string,
  options?: {
    getLoadedSkillNames?: () => string[];
    reloadRuntime?: () => Promise<void>;
  }
): Tool[] {
  return [
    new ListSkillsTool(workspaceDir, options?.getLoadedSkillNames),
    new CreateSkillScaffoldTool(workspaceDir),
    new SetSkillEnabledTool(workspaceDir),
    new ReloadAssistantRuntimeTool(options?.reloadRuntime)
  ];
}

class ListSkillsTool implements Tool {
  readonly definition = {
    name: "list_skills",
    description: "List workspace skills and whether each one is enabled, loaded, ignored, or missing files.",
    parameters: []
  };

  constructor(
    private readonly workspaceDir: string,
    private readonly getLoadedSkillNames?: () => string[]
  ) {}

  async execute(_args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const skillsRoot = path.join(this.workspaceDir, "skills");
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
    const loadedNames = new Set((this.getLoadedSkillNames?.() ?? []).map((name) => name.trim()).filter(Boolean));
    if (entries.length === 0) {
      return {
        ok: true,
        content: "No workspace skills found."
      };
    }

    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => renderSkillSummary(skillsRoot, entry.name, loadedNames)));

    return {
      ok: true,
      content: summaries.join("\n")
    };
  }
}

class CreateSkillScaffoldTool implements Tool {
  readonly definition = {
    name: "create_skill_scaffold",
    description: "Create a new workspace skill scaffold with manifest, instructions, and optional handler code.",
    approvalMode: "always" as const,
    parameters: [
      {
        name: "name",
        type: "string" as const,
        description: "Skill folder and manifest name, usually kebab-case.",
        required: true
      },
      {
        name: "description",
        type: "string" as const,
        description: "Short description of what the skill does.",
        required: true
      },
      {
        name: "instructions",
        type: "string" as const,
        description: "Human-editable instructions to seed SKILL.md."
      },
      {
        name: "include_handler",
        type: "string" as const,
        description: "Set to true to create a starter handler.js file."
      },
      {
        name: "enabled",
        type: "string" as const,
        description: "Set to true to enable the skill immediately. Defaults to false."
      }
    ]
  };

  constructor(private readonly workspaceDir: string) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const name = sanitizeSkillName(requiredString(args.name, "name"));
    const description = requiredString(args.description, "description").trim();
    const instructions = optionalString(args.instructions)?.trim() || defaultSkillInstructions(name, description);
    const includeHandler = parseBooleanFlag(optionalString(args.include_handler));
    const enabled = parseBooleanFlag(optionalString(args.enabled));

    const skillsRoot = path.join(this.workspaceDir, "skills");
    const skillDir = path.join(skillsRoot, name);
    const manifestPath = path.join(skillDir, "skill.json");
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const handlerPath = path.join(skillDir, "handler.js");

    await fs.mkdir(skillDir, { recursive: false });

    const manifest = {
      name,
      description,
      enabled,
      ...(includeHandler ? { entry: "handler.js" } : {})
    };

    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(skillMdPath, `${instructions.trim()}\n`, "utf8");

    if (includeHandler) {
      await fs.writeFile(handlerPath, buildHandlerTemplate(name), "utf8");
    }

    return {
      ok: true,
      content: [
        `Created workspace skill scaffold at skills/${name}.`,
        `Files: skill.json, SKILL.md${includeHandler ? ", handler.js" : ""}.`,
        enabled
          ? "The skill is enabled, but Kroosbot must restart to load newly created skills."
          : "The skill is disabled by default. Enable it in skill.json when you're ready."
      ].join("\n")
    };
  }
}

class SetSkillEnabledTool implements Tool {
  readonly definition = {
    name: "set_skill_enabled",
    description: "Enable or disable an existing workspace skill by updating its manifest.",
    approvalMode: "always" as const,
    parameters: [
      {
        name: "name",
        type: "string" as const,
        description: "Skill folder and manifest name.",
        required: true
      },
      {
        name: "enabled",
        type: "string" as const,
        description: "Set to true to enable or false to disable the skill.",
        required: true
      }
    ]
  };

  constructor(private readonly workspaceDir: string) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const name = sanitizeSkillName(requiredString(args.name, "name"));
    const enabledRaw = requiredString(args.enabled, "enabled");
    const enabled = parseBooleanString(enabledRaw, "enabled");
    const manifestPath = path.join(this.workspaceDir, "skills", name, "skill.json");
    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    manifest.enabled = enabled;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return {
      ok: true,
      content: enabled
        ? `Enabled skill ${name}. Run reload_assistant_runtime to load it into the current process.`
        : `Disabled skill ${name}. Run reload_assistant_runtime to unload it from the current process.`
    };
  }
}

class ReloadAssistantRuntimeTool implements Tool {
  readonly definition = {
    name: "reload_assistant_runtime",
    description: "Reload skills and tools from disk so newly added or updated workspace skills become active.",
    parameters: []
  };

  constructor(private readonly reloadRuntime?: () => Promise<void>) {}

  async execute(_args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!this.reloadRuntime) {
      return {
        ok: false,
        content: "Runtime reload is not available in this environment."
      };
    }

    await this.reloadRuntime();
    return {
      ok: true,
      content: "Reloaded the assistant runtime from disk. Newly enabled workspace skills are now active."
    };
  }
}

async function renderSkillSummary(
  skillsRoot: string,
  name: string,
  loadedNames: Set<string>
): Promise<string> {
  const skillDir = path.join(skillsRoot, name);
  const manifestPath = path.join(skillDir, "skill.json");
  const ignored = name.startsWith("_");
  const manifestRaw = await fs.readFile(manifestPath, "utf8").catch(() => null);

  if (ignored) {
    return `- ${name} [ignored] starts with "_"`;
  }

  if (!manifestRaw) {
    return `- ${name} [invalid] missing skill.json`;
  }

  try {
    const manifest = JSON.parse(manifestRaw) as {
      description?: unknown;
      enabled?: unknown;
      entry?: unknown;
    };
    const enabled = manifest.enabled === false ? "disabled" : "enabled";
    const description = typeof manifest.description === "string" && manifest.description.trim()
      ? manifest.description.trim()
      : "(no description)";
    const entry = typeof manifest.entry === "string" && manifest.entry.trim()
      ? ` entry=${manifest.entry.trim()}`
      : "";
    const loaded = loadedNames.has(name) ? " loaded" : "";
    return `- ${name} [${enabled}${loaded}] ${description}${entry}`;
  } catch (error) {
    return `- ${name} [invalid] unreadable skill.json: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function sanitizeSkillName(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("name must not be empty");
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(trimmed)) {
    throw new Error("name must be lowercase and may only include letters, numbers, hyphens, and underscores");
  }
  if (trimmed.startsWith("_")) {
    throw new Error("name must not start with '_' because loader ignores those folders");
  }
  return trimmed;
}

function parseBooleanFlag(value?: string): boolean {
  return value?.trim().toLowerCase() === "true";
}

function parseBooleanString(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

function defaultSkillInstructions(name: string, description: string): string {
  return [
    `# ${toTitleCase(name)}`,
    "",
    `Use this skill when the owner wants Kroosbot to help with ${description.toLowerCase()}.`,
    "",
    "Guidelines:",
    "",
    "- Ask only for the missing details needed to take the next concrete step.",
    "- Prefer using dedicated tools for this skill instead of generic repo exploration when possible.",
    "- Be explicit about any required installs, approvals, or restart steps.",
    "- If this request needs core app changes instead of a prompt-only skill, say so clearly and delegate the implementation work."
  ].join("\n");
}

function buildHandlerTemplate(name: string): string {
  return [
    "export async function registerSkill(_context) {",
    "  return {",
    `    instructions: "Runtime guidance for ${name}. Replace this with skill-specific behavior.",`,
    "    tools: []",
    "  };",
    "}",
    ""
  ].join("\n");
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
