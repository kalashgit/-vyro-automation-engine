import type { Pool } from "pg";
import { createQueue } from "../queue/queue.ts";
import { ProcessHeartbeat } from "./heartbeat.ts";

export interface WatchdogOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  recoveryLimit?: number;
  onRecovered?: (count: number) => void;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export async function runWatchdog(pool: Pool, options: WatchdogOptions = {}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const recoveryLimit = options.recoveryLimit ?? 100;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error("pollIntervalMs must be a positive integer.");
  if (!Number.isSafeInteger(recoveryLimit) || recoveryLimit < 1 || recoveryLimit > 1_000) throw new Error("recoveryLimit must be an integer between 1 and 1000.");

  const queue = createQueue(pool);
  const processHeartbeat = new ProcessHeartbeat(pool, "watchdog");
  await processHeartbeat.start();
  try {
    while (!options.signal?.aborted) {
      await processHeartbeat.heartbeat();
      const recovered = await queue.recoverExpired({ limit: recoveryLimit });
      if (recovered.length) options.onRecovered?.(recovered.length);
      await delay(pollIntervalMs, options.signal);
    }
  } finally {
    await processHeartbeat.stop();
  }
}