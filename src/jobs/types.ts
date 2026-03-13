export type JobStatus =
  | "queued"
  | "running"
  | "blocked"
  | "ready_for_review"
  | "completed"
  | "failed"
  | "rejected"
  | "canceled";

export type JobReviewDecision = "approve" | "request_changes" | "reject";

export type JobModelConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  runtimeCommand: string;
  runtimeArgs: string[];
};

export type JobReviewOutcome = {
  decision: JobReviewDecision;
  summary: string;
  reviewedAt: string;
  applied: boolean;
};

export type JobCheckResult = {
  command: string;
  exitCode: number;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  output: string;
};

export type JobRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceDir: string;
  worktreeDir: string;
  baseBranch: string;
  jobBranch: string;
  baseCommit: string;
  status: JobStatus;
  plannerSessionKey: string;
  runtime: "pi";
  pid?: number;
  modelConfig: JobModelConfig;
  planDocument: string;
  acceptanceCriteria: string[];
  checkCommands: string[];
  lastHeartbeatAt?: string;
  resultSummary?: string;
  reviewOutcome?: JobReviewOutcome;
  reviewInstructions?: string;
  allowedScope: string[];
  outOfScope: string[];
  checklist: string[];
  checkResults: JobCheckResult[];
};

export type JobEventType =
  | "job_created"
  | "worker_started"
  | "heartbeat"
  | "step_note"
  | "check_started"
  | "check_finished"
  | "worker_finished"
  | "review_requested"
  | "review_approved"
  | "review_rejected"
  | "job_canceled";

export type JobEvent = {
  at: string;
  type: JobEventType;
  message?: string;
  data?: Record<string, unknown>;
};

export type JobDelegatePayload = {
  title: string;
  workspaceDir?: string;
  summary: string;
  checklist?: string[];
  acceptanceCriteria?: string[];
  allowedScope?: string[];
  outOfScope?: string[];
  checkCommands?: string[];
  reviewInstructions?: string;
  planDocument?: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
};
