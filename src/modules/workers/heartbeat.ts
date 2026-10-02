import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Pool } from "pg";

export type ProcessKind = "worker" | "watchdog";
export type ProcessAvailability = "ready" | "not_configured" | "unavailable";
export interface ProcessAvailabilitySnapshot {
  worker: ProcessAvailability;
  watchdog: ProcessAvailability;
}

export class ProcessHeartbeat {
  readonly instanceId = randomUUID();
  readonly workerId = this.instanceId;
  private readonly pool: Pool;
  private readonly kind: ProcessKind;
  private started = false;

  constructor(pool: Pool, kind: ProcessKind) {
    this.pool = pool;
    this.kind = kind;
  }

  async start(): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_processes (process_instance_id, kind, worker_id, hostname, process_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [this.instanceId, this.kind, this.workerId, hostname(), process.pid],
    );
    this.started = true;
  }

  async heartbeat(): Promise<void> {
    if (!this.started) throw new Error("Process heartbeat has not started.");
    const result = await this.pool.query(
      `UPDATE worker_processes SET heartbeat_at = clock_timestamp()
       WHERE process_instance_id = $1 AND stopped_at IS NULL`,
      [this.instanceId],
    );
    if (result.rowCount !== 1) throw new Error("Process heartbeat record is missing or stopped.");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.pool.query(
      `UPDATE worker_processes SET stopped_at = clock_timestamp(), heartbeat_at = clock_timestamp()
       WHERE process_instance_id = $1 AND stopped_at IS NULL`,
      [this.instanceId],
    );
    this.started = false;
  }
}

export async function getProcessAvailability(pool: Pool, staleAfterMs = 30_000): Promise<ProcessAvailabilitySnapshot> {
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) throw new Error("Heartbeat timeout must be a positive integer.");
  const result = await pool.query<{
    worker_configured: boolean;
    worker_alive: boolean;
    watchdog_configured: boolean;
    watchdog_alive: boolean;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM worker_processes WHERE kind = 'worker') AS worker_configured,
       EXISTS (SELECT 1 FROM worker_processes WHERE kind = 'worker' AND stopped_at IS NULL
         AND heartbeat_at >= clock_timestamp() - ($1::integer * INTERVAL '1 millisecond')) AS worker_alive,
       EXISTS (SELECT 1 FROM worker_processes WHERE kind = 'watchdog') AS watchdog_configured,
       EXISTS (SELECT 1 FROM worker_processes WHERE kind = 'watchdog' AND stopped_at IS NULL
         AND heartbeat_at >= clock_timestamp() - ($1::integer * INTERVAL '1 millisecond')) AS watchdog_alive`,
    [staleAfterMs],
  );
  const row = result.rows[0];
  function availability(configured: boolean, alive: boolean): ProcessAvailability {
    return alive ? "ready" : configured ? "unavailable" : "not_configured";
  }
  return {
    worker: availability(row.worker_configured, row.worker_alive),
    watchdog: availability(row.watchdog_configured, row.watchdog_alive),
  };
}