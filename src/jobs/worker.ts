import { loadConfig } from "../config.js";
import { JobStore } from "./store.js";
import { PiJobRunner } from "./runtime/pi.js";
import type { JobRecord } from "./types.js";

async function main(): Promise<void> {
  const jobId = readJobId();
  const config = loadConfig();
  const store = new JobStore(config.jobs.rootDir);
  await store.initialize();
  const job = await store.getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const runningJob: JobRecord = {
    ...job,
    status: "running",
    lastHeartbeatAt: new Date().toISOString()
  };
  await store.saveJob(runningJob);
  await store.appendEvent(jobId, "worker_started", `Worker started for ${jobId}`, {
    pid: process.pid
  });

  const heartbeat = setInterval(() => {
    void store.updateHeartbeat(jobId);
    void store.appendEvent(jobId, "heartbeat", "worker heartbeat");
  }, config.jobs.heartbeatIntervalMs);

  const runner = new PiJobRunner(config, store);
  let finished = false;

  const shutdown = async (status: "canceled" | "failed", message: string) => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    runner.stop();
    const current = await store.getJob(jobId);
    if (!current) return;
    current.status = status;
    current.resultSummary = message;
    current.blockerQuestion = undefined;
    await store.saveJob(current);
    await store.appendEvent(jobId, status === "canceled" ? "job_canceled" : "worker_finished", message);
  };

  process.on("SIGTERM", () => {
    void shutdown("canceled", "Worker terminated by supervisor.");
  });
  process.on("SIGINT", () => {
    void shutdown("canceled", "Worker interrupted.");
  });

  try {
    const result = await runner.run(runningJob);
    clearInterval(heartbeat);
    finished = true;
    const latest = await store.getJob(jobId);
    if (!latest) return;
    latest.status = result.status;
    latest.resultSummary = result.summary;
    latest.blockerQuestion = result.blockerQuestion;
    latest.checkResults = result.checks;
    latest.lastHeartbeatAt = new Date().toISOString();
    await store.saveJob(latest);
    await store.appendEvent(jobId, "worker_finished", result.summary, {
      status: result.status
    });
  } catch (error) {
    await shutdown("failed", error instanceof Error ? error.message : String(error));
  }
}

function readJobId(): string {
  const index = process.argv.findIndex((value) => value === "--job");
  const jobId = index >= 0 ? process.argv[index + 1] : undefined;
  if (!jobId) {
    throw new Error("Missing required --job <id> argument");
  }
  return jobId;
}

main().catch((error) => {
  console.error("kroosbot job worker failed", error);
  process.exitCode = 1;
});
