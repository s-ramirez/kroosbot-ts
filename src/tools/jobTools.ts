import type { SubagentManager } from "../agents/manager.js";
import type { JobSupervisor } from "../jobs/supervisor.js";
import type { JobDelegatePayload } from "../jobs/types.js";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { optionalString, requiredString } from "./shared.js";

export function createJobTools(
  jobs: JobSupervisor,
  options: {
    reviewJob: (jobId: string) => Promise<string>;
    agents?: SubagentManager;
  }
): Tool[] {
  return [
    new DelegateJobTool(jobs, options.agents),
    new ListJobsTool(jobs),
    new GetJobStatusTool(jobs),
    new GetJobLogTool(jobs),
    new ClearJobTool(jobs),
    new ClearJobsTool(jobs),
    new ReviewJobTool(options.reviewJob),
    new ApproveJobTool(jobs),
    new RejectJobTool(jobs),
    new RetryJobTool(jobs, options.agents)
  ];
}

class DelegateJobTool implements Tool {
  readonly definition = {
    name: "delegate_job",
    description: "Start a long-running background coding job. Use agent_id to delegate to a specific sub-agent (e.g. 'carl').",
    parameters: [
      { name: "title", type: "string" as const, description: "Short job title.", required: true },
      { name: "summary", type: "string" as const, description: "What the worker should accomplish.", required: true },
      { name: "agent_id", type: "string" as const, description: "Sub-agent id to run the job (uses their model config)." },
      { name: "checklist", type: "string" as const, description: "Optional newline-separated checklist items." },
      { name: "acceptance_criteria", type: "string" as const, description: "Optional newline-separated acceptance criteria." },
      { name: "allowed_scope", type: "string" as const, description: "Optional newline-separated allowed files or scope limits." },
      { name: "out_of_scope", type: "string" as const, description: "Optional newline-separated out-of-scope items." },
      { name: "check_commands", type: "string" as const, description: "Optional newline-separated commands to run before review." },
      { name: "review_instructions", type: "string" as const, description: "Optional review guidance for the main assistant." },
      { name: "workspace_dir", type: "string" as const, description: "Optional absolute or relative workspace directory." },
      { name: "provider", type: "string" as const, description: "Optional provider override for the job runtime." },
      { name: "model", type: "string" as const, description: "Optional model override for the job runtime." }
    ]
  };

  constructor(
    private readonly jobs: JobSupervisor,
    private readonly agents?: SubagentManager
  ) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const explicitProvider = optionalString(args.provider);
    const explicitModel = optionalString(args.model);
    const agentId = optionalString(args.agent_id);

    // Resolve model config: explicit overrides > named agent > session agent > main brain
    const brainConfig = this.agents
      ? await this.agents.resolveJobModelConfig(context.sessionKey, agentId)
      : undefined;

    const payload: JobDelegatePayload = {
      title: requiredString(args.title, "title"),
      summary: requiredString(args.summary, "summary"),
      checklist: splitLines(optionalString(args.checklist)),
      acceptanceCriteria: splitLines(optionalString(args.acceptance_criteria)),
      allowedScope: splitLines(optionalString(args.allowed_scope)),
      outOfScope: splitLines(optionalString(args.out_of_scope)),
      checkCommands: splitLines(optionalString(args.check_commands)),
      reviewInstructions: optionalString(args.review_instructions),
      workspaceDir: optionalString(args.workspace_dir),
      provider: explicitProvider ?? brainConfig?.provider,
      model: explicitModel ?? brainConfig?.model,
      baseUrl: brainConfig?.baseUrl,
      apiKey: brainConfig?.apiKey,
      agentId: agentId ?? undefined
    };
    const job = await this.jobs.createAndStartJob(payload, context.sessionKey);
    const agentLabel = agentId ? ` (agent: ${agentId})` : "";
    return {
      ok: true,
      content: `Started background job ${job.id} on branch ${job.jobBranch}${agentLabel}. Use get_job_status to track progress.`
    };
  }
}

class ListJobsTool implements Tool {
  readonly definition = {
    name: "list_jobs",
    description: "List recent background jobs and their current statuses.",
    parameters: []
  };

  constructor(private readonly jobs: JobSupervisor) {}

  async execute(_args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const jobs = await this.jobs.listJobs();
    if (jobs.length === 0) {
      return { ok: true, content: "No background jobs yet." };
    }
    return {
      ok: true,
      content: jobs
        .slice(0, 10)
        .map((job) => `- ${job.id} [${job.status}] ${job.title} (${job.jobBranch})`)
        .join("\n")
    };
  }
}

class GetJobStatusTool implements Tool {
  readonly definition = {
    name: "get_job_status",
    description: "Get a detailed status report for one background job.",
    parameters: [
      { name: "job_id", type: "string" as const, description: "The job id to inspect.", required: true }
    ]
  };

  constructor(private readonly jobs: JobSupervisor) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const jobId = requiredString(args.job_id, "job_id");
    return { ok: true, content: await this.jobs.getJobStatusReport(jobId) };
  }
}

class GetJobLogTool implements Tool {
  readonly definition = {
    name: "get_job_log",
    description: "Read the recent worker log for a background job.",
    parameters: [
      { name: "job_id", type: "string" as const, description: "The job id to inspect.", required: true },
      { name: "max_chars", type: "string" as const, description: "Optional maximum characters to return." }
    ]
  };

  constructor(private readonly jobs: JobSupervisor) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const jobId = requiredString(args.job_id, "job_id");
    const maxCharsRaw = optionalString(args.max_chars);
    const maxChars = maxCharsRaw ? Number.parseInt(maxCharsRaw, 10) : 4000;
    return {
      ok: true,
      content: await this.jobs.getJobLog(jobId, Number.isFinite(maxChars) ? maxChars : 4000)
    };
  }
}

class ReviewJobTool implements Tool {
  readonly definition = {
    name: "review_job",
    description: "Review a background job. This may automatically restart the worker if changes are requested.",
    parameters: [
      { name: "job_id", type: "string" as const, description: "The job id to review.", required: true }
    ]
  };

  constructor(private readonly reviewJob: (jobId: string) => Promise<string>) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const jobId = requiredString(args.job_id, "job_id");
    return { ok: true, content: await this.reviewJob(jobId) };
  }
}

class ClearJobTool implements Tool {
  readonly definition = {
    name: "clear_job",
    description: "Delete one blocked or failed background job and remove its isolated worktree.",
    parameters: [
      { name: "job_id", type: "string" as const, description: "The job id to clear.", required: true }
    ]
  };

  constructor(private readonly jobs: JobSupervisor) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const jobId = requiredString(args.job_id, "job_id");
    const job = await this.jobs.clearJob(jobId);
    return { ok: true, content: `Cleared job ${job.id} (${job.status}).` };
  }
}

class ClearJobsTool implements Tool {
  readonly definition = {
    name: "clear_jobs",
    description: "Delete blocked and/or failed background jobs in bulk.",
    parameters: [
      { name: "statuses", type: "string" as const, description: "Optional newline-separated statuses. Supported values: blocked, failed." }
    ]
  };

  constructor(private readonly jobs: JobSupervisor) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const rawStatuses = splitLines(optionalString(args.statuses));
    const statuses = (rawStatuses?.length ? rawStatuses : ["blocked", "failed"])
      .map((status) => status.toLowerCase())
      .filter((status): status is "blocked" | "failed" => status === "blocked" || status === "failed");
    const cleared = await this.jobs.clearJobs(statuses);
    if (cleared.length === 0) {
      return { ok: true, content: `No ${statuses.join("/")} jobs to clear.` };
    }
    return {
      ok: true,
      content: `Cleared ${cleared.length} job(s): ${cleared.map((job) => `${job.id} [${job.status}]`).join(", ")}`
    };
  }
}

class ApproveJobTool implements Tool {
  readonly definition = {
    name: "approve_job",
    description: "Mark a reviewed job as approved.",
    parameters: [
      { name: "job_id", type: "string" as const, description: "The job id to approve.", required: true }
    ]
  };

  constructor(private readonly jobs: JobSupervisor) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const jobId = requiredString(args.job_id, "job_id");
    const job = await this.jobs.markReviewOutcome(jobId, "approve", "Approved by main assistant.");
    return { ok: true, content: `Approved job ${job.id}.` };
  }
}

class RejectJobTool implements Tool {
  readonly definition = {
    name: "reject_job",
    description: "Reject a reviewed job and reset its branch to the base commit.",
    parameters: [
      { name: "job_id", type: "string" as const, description: "The job id to reject.", required: true }
    ]
  };

  constructor(private readonly jobs: JobSupervisor) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const jobId = requiredString(args.job_id, "job_id");
    const job = await this.jobs.markReviewOutcome(jobId, "reject", "Rejected by main assistant.");
    return { ok: true, content: `Rejected job ${job.id} and reset branch ${job.jobBranch} to ${job.baseCommit}.` };
  }
}

class RetryJobTool implements Tool {
  readonly definition = {
    name: "retry_job",
    description: "Retry a background job from a clean reset state. Uses the session's active agent model config if available.",
    parameters: [
      { name: "job_id", type: "string" as const, description: "The job id to retry.", required: true }
    ]
  };

  constructor(
    private readonly jobs: JobSupervisor,
    private readonly agents?: SubagentManager
  ) {}

  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const jobId = requiredString(args.job_id, "job_id");
    const existingJob = await this.jobs.getJob(jobId);
    const brainConfig = this.agents
      ? await this.agents.resolveJobModelConfig(context.sessionKey, existingJob?.agentId)
      : undefined;
    const job = await this.jobs.retryJob(jobId, brainConfig);
    return { ok: true, content: `Retried job ${job.id} on branch ${job.jobBranch} with model ${job.modelConfig.provider}/${job.modelConfig.model}.` };
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
