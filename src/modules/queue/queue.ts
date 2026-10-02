import type { Pool, QueryResultRow } from "pg";
import { withTransaction as transaction } from "../database/client.ts";
import { JOB_TYPES } from "./types.ts";
import type { ClaimOptions, EnqueueInput, EnqueueResult, Job, JobLease, JobPayload, JobStatus, JobType, LeasedJob, QueueStats } from "./types.ts";
const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 3_600_000;
const MAX_PAYLOAD_BYTES = 262_144;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class QueueValidationError extends Error {
  constructor(message: string) { super(message); this.name = "QueueValidationError"; }
}
export class IdempotencyConflictError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super("Idempotency key already exists with different job inputs.");
    this.name = "IdempotencyConflictError"; this.idempotencyKey = idempotencyKey;
  }
}
export class LeaseLostError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super("Job lease is expired, missing, or owned by another claim.");
    this.name = "LeaseLostError"; this.jobId = jobId;
  }
}
interface JobRow extends QueryResultRow {
  job_id: string; type: JobType; payload: JobPayload; idempotency_key: string; status: JobStatus;
  attempts: number; max_attempts: number; retry_backoff_ms: number; retry_max_backoff_ms: number;
  available_at: Date; scheduled_at: Date | null; lease_token: string | null; leased_by: string | null;
  lease_expires_at: Date | null; heartbeat_at: Date | null; last_error: string | null;
  created_at: Date; updated_at: Date; finished_at: Date | null;
}
function toJob(row: JobRow): Job {
  return {
    id: row.job_id, type: row.type, payload: row.payload, idempotencyKey: row.idempotency_key,
    status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
    retryBackoffMs: row.retry_backoff_ms, retryMaxBackoffMs: row.retry_max_backoff_ms,
    availableAt: row.available_at, scheduledAt: row.scheduled_at, leaseToken: row.lease_token,
    leasedBy: row.leased_by, leaseExpiresAt: row.lease_expires_at, heartbeatAt: row.heartbeat_at,
    lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
  };
}
function toLeasedJob(row: JobRow): LeasedJob {
  const job = toJob(row);
  if (job.status !== "leased" || !job.leaseToken || !job.leasedBy || !job.leaseExpiresAt || !job.heartbeatAt) throw new Error("Database returned an inconsistent job lease.");
  return { ...job, status: "leased", leaseToken: job.leaseToken, leasedBy: job.leasedBy, leaseExpiresAt: job.leaseExpiresAt, heartbeatAt: job.heartbeatAt };
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new QueueValidationError(name + " must be an integer between " + min + " and " + max + ".");
  return value;
}
function text(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maxLength || value.includes("\0")) throw new QueueValidationError(name + " must be nonempty, trimmed text of at most " + maxLength + " characters.");
  return value;
}
function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new QueueValidationError(name + " must be a UUID.");
  return value;
}
function isJobType(value: unknown): value is JobType { return typeof value === "string" && JOB_TYPES.some((type) => type === value); }
function serializePayload(payload: JobPayload): string {
  const visited = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (depth > 64) throw new QueueValidationError("Job payload is nested too deeply.");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (value.includes("\0")) throw new QueueValidationError("Job payload cannot contain null characters.");
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || value === null) throw new QueueValidationError("Job payload must contain only JSON values.");
    if (visited.has(value)) throw new QueueValidationError("Job payload cannot contain cycles.");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new QueueValidationError("Job payload must contain only plain JSON objects.");
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (key.includes("\0")) throw new QueueValidationError("Job payload keys cannot contain null characters.");
      visit(child, depth + 1);
    }
    visited.delete(value);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new QueueValidationError("Job payload must be a JSON object.");
  visit(payload, 0);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) throw new QueueValidationError("Job payload exceeds the 256 KiB limit.");
  return serialized;
}
function validateLease(lease: JobLease): void {
  if (typeof lease !== "object" || lease === null) throw new QueueValidationError("A job lease is required.");
  uuid(lease.jobId, "jobId"); uuid(lease.leaseToken, "leaseToken"); text(lease.workerId, "workerId");
}
const leaseGuard = "job_id = $1::uuid AND status = 'leased' AND leased_by = $2 AND lease_token = $3::uuid AND lease_expires_at > clock_timestamp()";
// Attempts count claims, including claims whose worker crashes. Backoff is capped
// before interval conversion, so repeated crashes cannot create unbounded delays.
const retryDelay = "LEAST(retry_max_backoff_ms::double precision, retry_backoff_ms::double precision * power(2::double precision, attempts - 1)) * INTERVAL '1 millisecond'";

/**
 * Durable queue operations only. No dispatch, provider calls, or outbound messaging.
 * Each lease mutation locks first, then checks database time after acquiring the
 * lock; an expiry crossed while waiting can never authorize a stale completion.
 */
export class DurableQueue {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    if (typeof input !== "object" || input === null || !isJobType(input.type)) throw new QueueValidationError("Unsupported queue job type.");
    const key = text(input.idempotencyKey, "idempotencyKey");
    const payload = serializePayload(input.payload);
    const maxAttempts = integer(input.maxAttempts ?? 5, "maxAttempts", 1, 100);
    const retryBackoffMs = integer(input.retryBackoffMs ?? 1_000, "retryBackoffMs", 1, 3_600_000);
    const retryMaxBackoffMs = integer(input.retryMaxBackoffMs ?? 60_000, "retryMaxBackoffMs", retryBackoffMs, 86_400_000);
    const scheduledAt = input.availableAt ?? null;
    if (scheduledAt !== null && (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime()))) throw new QueueValidationError("availableAt must be a valid Date.");
    const values = [input.type, payload, key, maxAttempts, retryBackoffMs, retryMaxBackoffMs, scheduledAt];
    return transaction(this.pool, async (client) => {
      const inserted = await client.query<JobRow>(`
        INSERT INTO jobs (type, payload, idempotency_key, max_attempts, retry_backoff_ms, retry_max_backoff_ms, scheduled_at, available_at)
        VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::timestamptz, COALESCE($7::timestamptz, clock_timestamp()))
        ON CONFLICT (idempotency_key) DO NOTHING RETURNING *
      `, values);
      if (inserted.rows[0]) return { job: toJob(inserted.rows[0]), created: true };
      // A separate statement sees a concurrent inserter's committed row under
      // READ COMMITTED, unlike an INSERT/SELECT CTE with one statement snapshot.
      const existing = await client.query<JobRow & { enqueue_matches: boolean }>(`
        SELECT *, (type = $1 AND payload = $2::jsonb AND max_attempts = $4 AND retry_backoff_ms = $5 AND retry_max_backoff_ms = $6 AND scheduled_at IS NOT DISTINCT FROM $7::timestamptz) AS enqueue_matches
        FROM jobs WHERE idempotency_key = $3
      `, values);
      if (!existing.rows[0]) throw new Error("Conflicting queue job disappeared during enqueue.");
      if (!existing.rows[0].enqueue_matches) throw new IdempotencyConflictError(key);
      return { job: toJob(existing.rows[0]), created: false };
    });
  }
  async claim(workerId: string, options: ClaimOptions = {}): Promise<LeasedJob | null> {
    text(workerId, "workerId");
    const leaseDurationMs = integer(options.leaseDurationMs ?? DEFAULT_LEASE_MS, "leaseDurationMs", 1, MAX_LEASE_MS);
    let types: JobType[] | null = null;
    if (options.types !== undefined) {
      if (!Array.isArray(options.types) || !options.types.every(isJobType)) throw new QueueValidationError("Claim types must be supported queue job types.");
      types = [...new Set(options.types)]; if (types.length === 0) return null;
    }
    const result = await this.pool.query<JobRow>(`
      WITH candidate AS (
        SELECT job_id FROM jobs
        WHERE status IN ('queued', 'retry') AND available_at <= clock_timestamp() AND attempts < max_attempts AND ($3::text[] IS NULL OR type = ANY($3::text[]))
        ORDER BY available_at, created_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs AS j SET status = 'leased', attempts = j.attempts + 1, lease_token = gen_random_uuid(), leased_by = $1,
        lease_expires_at = clock_timestamp() + $2::integer * INTERVAL '1 millisecond', heartbeat_at = clock_timestamp(), updated_at = clock_timestamp(), finished_at = NULL
      FROM candidate WHERE j.job_id = candidate.job_id RETURNING j.*
    `, [workerId, leaseDurationMs, types]);
    return result.rows[0] ? toLeasedJob(result.rows[0]) : null;
  }
  private async mutateLease(lease: JobLease, sql: string, extraValues: unknown[] = []): Promise<JobRow> {
    validateLease(lease);
    return transaction(this.pool, async (client) => {
      await client.query("SELECT job_id FROM jobs WHERE job_id = $1::uuid FOR UPDATE", [lease.jobId]);
      const result = await client.query<JobRow>(sql, [lease.jobId, lease.workerId, lease.leaseToken, ...extraValues]);
      if (!result.rows[0]) throw new LeaseLostError(lease.jobId);
      return result.rows[0];
    });
  }
  async renewLease(lease: JobLease, leaseDurationMs = DEFAULT_LEASE_MS): Promise<LeasedJob> {
    integer(leaseDurationMs, "leaseDurationMs", 1, MAX_LEASE_MS);
    const row = await this.mutateLease(lease, `
      UPDATE jobs SET lease_expires_at = GREATEST(lease_expires_at, clock_timestamp() + $4::integer * INTERVAL '1 millisecond'), heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE ${leaseGuard} RETURNING *
    `, [leaseDurationMs]);
    return toLeasedJob(row);
  }
  async complete(lease: JobLease): Promise<Job> {
    const row = await this.mutateLease(lease, `
      UPDATE jobs SET status = 'succeeded', lease_token = NULL, leased_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
        last_error = NULL, finished_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE ${leaseGuard} RETURNING *
    `);
    return toJob(row);
  }

  async fail(lease: JobLease, error: string, options: { retryable?: boolean } = {}): Promise<Job> {
    if (typeof error !== "string" || !error.trim() || error.length > 4_000 || error.includes("\0")) throw new QueueValidationError("Failure reason must be nonempty text of at most 4000 characters.");
    if (options.retryable !== undefined && typeof options.retryable !== "boolean") throw new QueueValidationError("retryable must be a boolean.");
    const row = await this.mutateLease(lease, `
      UPDATE jobs SET status = CASE WHEN $4::boolean AND attempts < max_attempts THEN 'retry' ELSE 'dead' END,
        available_at = CASE WHEN $4::boolean AND attempts < max_attempts THEN clock_timestamp() + ${retryDelay} ELSE available_at END,
        finished_at = CASE WHEN $4::boolean AND attempts < max_attempts THEN NULL ELSE clock_timestamp() END,
        lease_token = NULL, leased_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL, last_error = $5, updated_at = clock_timestamp()
      WHERE ${leaseGuard} RETURNING *
    `, [options.retryable ?? true, error]);
    return toJob(row);
  }
  /** Recovery is explicit; claim never silently steals an expired lease. */
  async recoverExpired(options: { limit?: number } = {}): Promise<Job[]> {
    const limit = integer(options.limit ?? 100, "recovery limit", 1, 1_000);
    const result = await this.pool.query<JobRow>(`
      WITH expired AS (
        SELECT job_id FROM jobs WHERE status = 'leased' AND lease_expires_at <= clock_timestamp()
        ORDER BY lease_expires_at, job_id LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs AS j SET status = CASE WHEN attempts < max_attempts THEN 'retry' ELSE 'dead' END,
        available_at = CASE WHEN attempts < max_attempts THEN clock_timestamp() + ${retryDelay} ELSE available_at END,
        finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE clock_timestamp() END,
        lease_token = NULL, leased_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
        last_error = 'Lease expired before acknowledgement', updated_at = clock_timestamp()
      FROM expired WHERE j.job_id = expired.job_id RETURNING j.*
    `, [limit]);
    return result.rows.map(toJob);
  }
  async get(jobId: string): Promise<Job | null> {
    uuid(jobId, "jobId");
    const result = await this.pool.query<JobRow>("SELECT * FROM jobs WHERE job_id = $1::uuid", [jobId]);
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }
  async stats(): Promise<QueueStats> {
    interface StatsRow extends QueryResultRow {
      queued: string; leased: string; succeeded: string; retry: string; dead: string;
      total: string; ready: string; expired_leases: string; oldest_ready_at: Date | null;
    }
    const result = await this.pool.query<StatsRow>(`
      SELECT count(*) FILTER (WHERE status = 'queued')::text AS queued,
        count(*) FILTER (WHERE status = 'leased')::text AS leased,
        count(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
        count(*) FILTER (WHERE status = 'retry')::text AS retry,
        count(*) FILTER (WHERE status = 'dead')::text AS dead, count(*)::text AS total,
        count(*) FILTER (WHERE status IN ('queued', 'retry') AND available_at <= clock_timestamp())::text AS ready,
        count(*) FILTER (WHERE status = 'leased' AND lease_expires_at <= clock_timestamp())::text AS expired_leases,
        min(available_at) FILTER (WHERE status IN ('queued', 'retry') AND available_at <= clock_timestamp()) AS oldest_ready_at
      FROM jobs
    `);
    const row = result.rows[0];
    function count(value: string): number {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Queue count exceeds safe numeric range.");
      return parsed;
    }
    return { queued: count(row.queued), leased: count(row.leased), succeeded: count(row.succeeded), retry: count(row.retry), dead: count(row.dead), total: count(row.total), ready: count(row.ready), expiredLeases: count(row.expired_leases), oldestReadyAt: row.oldest_ready_at };
  }
}
export function createQueue(pool: Pool): DurableQueue { return new DurableQueue(pool); }
