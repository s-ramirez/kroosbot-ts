export type ScheduledTaskKind = "prompt" | "heartbeat";
export type ScheduledTaskStatus = "active" | "paused" | "completed" | "canceled";
export type ScheduledTaskScheduleType = "at" | "every" | "cron";

export type ScheduledTaskRecord = {
  id: string;
  kind: ScheduledTaskKind;
  agentId?: string;
  sessionTarget: string;
  scheduleType: ScheduledTaskScheduleType;
  runAt?: string;
  intervalMs?: number;
  cronExpr?: string;
  prompt: string;
  deliveryAdapter?: string;
  deliveryAddress?: string;
  status: ScheduledTaskStatus;
  isInternal: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
};

export type ScheduledTaskInput = {
  id?: string;
  kind?: ScheduledTaskKind;
  agentId?: string;
  sessionTarget: string;
  scheduleType: ScheduledTaskScheduleType;
  runAt?: string;
  intervalMs?: number;
  cronExpr?: string;
  prompt: string;
  deliveryAdapter?: string;
  deliveryAddress?: string;
  status?: ScheduledTaskStatus;
  isInternal?: boolean;
};
