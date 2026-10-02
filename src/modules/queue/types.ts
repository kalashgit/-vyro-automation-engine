export const JOB_TYPES = ["ingest_batch", "reconcile_identity", "enrich_contact", "verify_contact", "suppression_check", "prepare_outreach"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = "queued" | "leased" | "succeeded" | "retry" | "dead";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JobPayload = { [key: string]: JsonValue };
export interface Job {
  id: string; type: JobType; payload: JobPayload; idempotencyKey: string; status: JobStatus;
  attempts: number; maxAttempts: number; retryBackoffMs: number; retryMaxBackoffMs: number;
  /** Current eligibility time, changed by retries. */
  availableAt: Date;
  /** Original optional schedule, preserved for idempotency comparison. */
  scheduledAt: Date | null;
  leaseToken: string | null; leasedBy: string | null; leaseExpiresAt: Date | null;
  heartbeatAt: Date | null; lastError: string | null;
  createdAt: Date; updatedAt: Date; finishedAt: Date | null;
}
export interface LeasedJob extends Job {
  status: "leased"; leaseToken: string; leasedBy: string; leaseExpiresAt: Date; heartbeatAt: Date;
}
/** Keep the exact token returned by claim; a reclaimed job receives a new token. */
export interface JobLease { jobId: string; workerId: string; leaseToken: string; }
export interface EnqueueInput {
  type: JobType; payload: JobPayload; idempotencyKey: string; maxAttempts?: number;
  retryBackoffMs?: number; retryMaxBackoffMs?: number; availableAt?: Date;
}
export interface EnqueueResult { job: Job; created: boolean; }
export interface ClaimOptions { leaseDurationMs?: number; types?: readonly JobType[]; }
export interface QueueStats {
  queued: number; leased: number; succeeded: number; retry: number; dead: number;
  total: number; ready: number; expiredLeases: number; oldestReadyAt: Date | null;
}
