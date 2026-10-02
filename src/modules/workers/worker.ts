import type { Pool } from "pg";
import { createQueue, LeaseLostError } from "../queue/queue.ts";
import type { JobLease, JobType, LeasedJob } from "../queue/types.ts";
import { ProcessHeartbeat } from "./heartbeat.ts";

export type JobHandler = (job: LeasedJob, context: { signal: AbortSignal }) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;
export interface WorkerOptions {
  handlers: JobHandlers;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
}

export class JobExecutionError extends Error {
  readonly retryable: boolean;
  readonly code: string;

  constructor(code: string, options: { retryable?: boolean } = {}) {
    super("Queue job handler failed.");
    this.name = "JobExecutionError";
    this.code = /^[A-Z0-9_]{1,80}$/.test(code) ? code : "HANDLER_FAILED";
    this.retryable = options.retryable ?? true;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + " must be a positive integer.");
  return value;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function runWorker(pool: Pool, options: WorkerOptions): Promise<void> {
  const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
  const heartbeatIntervalMs = positiveInteger(options.heartbeatIntervalMs ?? 10_000, "heartbeatIntervalMs");
  const leaseDurationMs = positiveInteger(options.leaseDurationMs ?? 30_000, "leaseDurationMs");
  if (heartbeatIntervalMs * 2 >= leaseDurationMs) throw new Error("Lease duration must exceed twice the heartbeat interval.");
  const types = Object.keys(options.handlers) as JobType[];
  const queue = createQueue(pool);
  const processHeartbeat = new ProcessHeartbeat(pool, "worker");
  const serviceController = new AbortController();
  let fatalError: unknown;
  let processHeartbeatPending: Promise<void> | undefined;
  const abortService = () => serviceController.abort(options.signal?.reason);

  await processHeartbeat.start();
  options.signal?.addEventListener("abort", abortService, { once: true });
  if (options.signal?.aborted) abortService();
  const processHeartbeatTimer = setInterval(() => {
    if (processHeartbeatPending || serviceController.signal.aborted) return;
    processHeartbeatPending = processHeartbeat.heartbeat().catch((error: unknown) => {
      fatalError = error;
      serviceController.abort(error);
    }).finally(() => { processHeartbeatPending = undefined; });
  }, heartbeatIntervalMs);

  async function execute(job: LeasedJob, handler: JobHandler): Promise<void> {
    const lease: JobLease = { jobId: job.id, workerId: processHeartbeat.workerId, leaseToken: job.leaseToken };
    const jobController = new AbortController();
    const abortJob = () => jobController.abort(serviceController.signal.reason);
    serviceController.signal.addEventListener("abort", abortJob, { once: true });
    if (serviceController.signal.aborted) abortJob();
    let renewalPending: Promise<void> | undefined;
    let renewalError: unknown;
    let renewalsStopped = false;
    const renewalTimer = setInterval(() => {
      if (renewalsStopped || renewalPending || jobController.signal.aborted) return;
      renewalPending = queue.renewLease(lease, leaseDurationMs).then(() => undefined).catch((error: unknown) => {
        renewalError = error;
        fatalError = error;
        serviceController.abort(error);
        jobController.abort(error);
      }).finally(() => { renewalPending = undefined; });
    }, heartbeatIntervalMs);

    async function stopRenewals(): Promise<void> {
      renewalsStopped = true;
      clearInterval(renewalTimer);
      if (renewalPending) await renewalPending;
    }

    try {
      if (jobController.signal.aborted) return;
      await handler(job, { signal: jobController.signal });
      await stopRenewals();
      if (jobController.signal.aborted || renewalError) return;
      await queue.complete(lease);
    } catch (error) {
      await stopRenewals();
      if (jobController.signal.aborted) return;
      const code = error instanceof JobExecutionError ? error.code : "HANDLER_FAILED";
      const retryable = error instanceof JobExecutionError ? error.retryable : true;
      try {
        await queue.fail(lease, "Job execution failed: " + code, { retryable });
      } catch (failure: unknown) {
        if (!(failure instanceof LeaseLostError)) throw failure;
      }
    } finally {
      await stopRenewals();
      serviceController.signal.removeEventListener("abort", abortJob);
      if (renewalPending) await renewalPending;
      if (renewalError) fatalError ??= renewalError;
    }
  }

  try {
    while (!serviceController.signal.aborted) {
      if (fatalError) throw fatalError;
      const claimed = types.length
        ? await queue.claim(processHeartbeat.workerId, { types, leaseDurationMs })
        : null;
      if (serviceController.signal.aborted) break;
      if (!claimed) {
        await delay(pollIntervalMs, serviceController.signal);
        continue;
      }
      const handler = options.handlers[claimed.type];
      if (handler) await execute(claimed, handler);
    }
    if (fatalError) throw fatalError;
  } finally {
    clearInterval(processHeartbeatTimer);
    if (processHeartbeatPending) await processHeartbeatPending;
    options.signal?.removeEventListener("abort", abortService);
    serviceController.abort();
    await processHeartbeat.stop();
  }
}