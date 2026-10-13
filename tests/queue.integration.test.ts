import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { applyMigrations } from "../src/modules/database/migrate.ts";
import { createQueue, IdempotencyConflictError, LeaseLostError, QueueValidationError } from "../src/modules/queue/queue.ts";
import type { Job, JobLease } from "../src/modules/queue/types.ts";
import { createDatabaseFixture } from "./helpers/database.ts";
import type { DatabaseFixture } from "./helpers/database.ts";
function leaseFor(job: Job): JobLease {
  assert.equal(job.status, "leased"); assert.ok(job.leasedBy); assert.ok(job.leaseToken);
  return { jobId: job.id, workerId: job.leasedBy, leaseToken: job.leaseToken };
}
describe("PostgreSQL durable queue", { concurrency: false }, () => {
  let fixture: DatabaseFixture;
  let queue: ReturnType<typeof createQueue>;
  before(async () => { fixture = await createDatabaseFixture(); await applyMigrations(fixture.pool); queue = createQueue(fixture.pool); });
  after(async () => { if (fixture) await fixture.dispose(); });
  beforeEach(async () => { await fixture.pool.query("DELETE FROM jobs"); });
  async function ready(jobId: string) {
    await fixture.pool.query("UPDATE jobs SET available_at = clock_timestamp() - interval '1 second' WHERE job_id = $1", [jobId]);
  }
  async function expire(jobId: string) {
    await fixture.pool.query("UPDATE jobs SET heartbeat_at = clock_timestamp() - interval '2 seconds', lease_expires_at = clock_timestamp() - interval '1 second' WHERE job_id = $1", [jobId]);
  }
  async function retryDelay(jobId: string): Promise<number> {
    const result = await fixture.pool.query<{ delay_ms: number }>(
      "SELECT (EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000)::float8 AS delay_ms FROM jobs WHERE job_id = $1", [jobId]);
    return result.rows[0].delay_ms;
  }
  test("persists jobs independently of queue instances and completes them", async () => {
    const input = { type: "ingest_batch" as const, payload: { fixture: "durability", batchId: randomUUID() }, idempotencyKey: "durable-job" };
    const { job, created } = await queue.enqueue(input);
    assert.equal(created, true); assert.equal(job.status, "queued"); assert.equal(job.attempts, 0);
    const otherQueue = createQueue(fixture.pool);
    assert.deepEqual((await otherQueue.get(job.id))?.payload, input.payload);
    assert.equal(await otherQueue.get(randomUUID()), null);
    const claimed = await otherQueue.claim("worker-a"); assert.ok(claimed);
    assert.equal(claimed.id, job.id); assert.equal(claimed.attempts, 1); assert.ok(claimed.heartbeatAt);
    const completed = await otherQueue.complete(leaseFor(claimed));
    assert.equal(completed.status, "succeeded"); assert.ok(completed.finishedAt);
    assert.equal(completed.leaseToken, null); assert.equal(completed.leasedBy, null); assert.equal(completed.leaseExpiresAt, null);
    assert.equal(await queue.claim("worker-b"), null);
  });
  test("concurrent duplicate enqueue creates exactly one durable job", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => queue.enqueue({
      type: "reconcile_identity", payload: { recordId: "fixture-001", evidence: { a: 1, b: 2 } }, idempotencyKey: "same-idempotency-key" })));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.job.id)).size, 1);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count, 1);
    const duplicate = await queue.enqueue({
      type: "reconcile_identity", payload: { evidence: { b: 2, a: 1 }, recordId: "fixture-001" }, idempotencyKey: "same-idempotency-key" });
    assert.equal(duplicate.created, false); assert.equal(duplicate.job.id, results[0].job.id);
  });
  test("idempotency keys reject changes to the original job contract", async () => {
    const input = { type: "enrich_contact" as const, payload: { recordId: "fixture-002" }, idempotencyKey: "immutable-job-contract",
      maxAttempts: 3, retryBackoffMs: 1_000, retryMaxBackoffMs: 4_000, availableAt: new Date("2099-01-01T00:00:00.000Z") };
    await queue.enqueue(input);
    for (const change of [{ payload: { recordId: "different" } }, { type: "verify_contact" as const }, { maxAttempts: 4 },
      { retryBackoffMs: 2_000 }, { retryMaxBackoffMs: 5_000 }, { availableAt: new Date("2099-01-02T00:00:00.000Z") }]) {
      await assert.rejects(queue.enqueue({ ...input, ...change }), IdempotencyConflictError);
    }
    assert.equal(await queue.claim("worker-a"), null);
  });
  test("future jobs wait for their schedule and job-type filters are respected", async () => {
    const scheduled = await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "scheduled", availableAt: new Date(Date.now() + 86_400_000) });
    const immediate = await queue.enqueue({ type: "enrich_contact", payload: {}, idempotencyKey: "immediate" });
    assert.equal(await queue.claim("worker-a", { types: ["ingest_batch"] }), null);
    const claimed = await queue.claim("worker-a", { types: ["enrich_contact"] }); assert.ok(claimed);
    assert.equal(claimed.id, immediate.job.id); await queue.complete(leaseFor(claimed));
    assert.equal(await queue.claim("worker-b"), null); assert.equal((await queue.get(scheduled.job.id))?.attempts, 0);
  });
  test("two workers claim concurrently without duplicate ownership", async () => {
    const count = 40;
    await Promise.all(Array.from({ length: count }, (_, index) => queue.enqueue({
      type: "suppression_check", payload: { recordId: "synthetic-fixture-" + index }, idempotencyKey: "parallel-" + index })));
    const claims = await Promise.all(Array.from({ length: count }, (_, index) => queue.claim(index % 2 === 0 ? "worker-a" : "worker-b")));
    assert.ok(claims.every((job) => job !== null));
    assert.equal(new Set(claims.map((job) => job!.id)).size, count);
    assert.equal(new Set(claims.map((job) => job!.leaseToken)).size, count);
    assert.equal(claims.filter((job) => job!.leasedBy === "worker-a").length, 20);
    assert.equal(claims.filter((job) => job!.leasedBy === "worker-b").length, 20);
    assert.ok(claims.every((job) => job!.attempts === 1)); assert.equal(await queue.claim("worker-c"), null);
  });
  test("SKIP LOCKED advances past a row held by another transaction", async () => {
    const first = await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "locked-first", availableAt: new Date(Date.now() - 60_000) });
    const second = await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "unlocked-second", availableAt: new Date(Date.now() - 30_000) });
    const locker = await fixture.pool.connect();
    try {
      await locker.query("BEGIN"); await locker.query("SELECT job_id FROM jobs WHERE job_id = $1 FOR UPDATE", [first.job.id]);
      const claimed = await queue.claim("worker-b"); assert.ok(claimed); assert.equal(claimed.id, second.job.id);
      await queue.complete(leaseFor(claimed));
    } finally { await locker.query("ROLLBACK"); locker.release(); }
    const next = await queue.claim("worker-a"); assert.ok(next); assert.equal(next.id, first.job.id);
  });
  test("lease renewal updates heartbeat and extends the database-clock deadline", async () => {
    await queue.enqueue({ type: "prepare_outreach", payload: {}, idempotencyKey: "renew" });
    const claimed = await queue.claim("worker-a", { leaseDurationMs: 5_000 }); assert.ok(claimed);
    const renewed = await queue.renewLease(leaseFor(claimed), 30_000);
    assert.ok(renewed.leaseExpiresAt.getTime() > claimed.leaseExpiresAt.getTime());
    assert.ok(renewed.heartbeatAt); assert.equal(renewed.attempts, 1); assert.equal(renewed.leaseToken, claimed.leaseToken);
    const shorter = await queue.renewLease(leaseFor(renewed), 1);
    assert.ok(shorter.leaseExpiresAt.getTime() >= renewed.leaseExpiresAt.getTime());
    await queue.complete(leaseFor(shorter));
  });
  test("worker, token and job ID fence every lease mutation", async () => {
    await queue.enqueue({ type: "verify_contact", payload: {}, idempotencyKey: "fenced" });
    const claimed = await queue.claim("worker-a"); assert.ok(claimed);
    const valid = leaseFor(claimed);
    for (const stale of [{ ...valid, workerId: "worker-b" }, { ...valid, leaseToken: randomUUID() }, { ...valid, jobId: randomUUID() }]) {
      await assert.rejects(queue.renewLease(stale), LeaseLostError);
      await assert.rejects(queue.complete(stale), LeaseLostError);
      await assert.rejects(queue.fail(stale, "stale worker"), LeaseLostError);
    }
    assert.equal((await queue.get(claimed.id))?.status, "leased"); await queue.complete(valid);
    await assert.rejects(queue.complete(valid), LeaseLostError); await assert.rejects(queue.renewLease(valid), LeaseLostError);
  });
  test("an expired lease cannot complete, fail or renew before recovery", async () => {
    await queue.enqueue({ type: "verify_contact", payload: {}, idempotencyKey: "expired" });
    const claimed = await queue.claim("worker-a"); assert.ok(claimed); await expire(claimed.id);
    const lease = leaseFor(claimed);
    await assert.rejects(queue.complete(lease), LeaseLostError); await assert.rejects(queue.fail(lease, "expired failure"), LeaseLostError);
    await assert.rejects(queue.renewLease(lease), LeaseLostError); assert.equal((await queue.get(claimed.id))?.status, "leased");
  });

  test("retry delay doubles, is capped, and exhausted attempts become dead", async () => {
    const { job } = await queue.enqueue({ type: "enrich_contact", payload: {}, idempotencyKey: "retry",
      maxAttempts: 4, retryBackoffMs: 10_000, retryMaxBackoffMs: 25_000 });
    for (const [index, expectedDelay] of [10_000, 20_000, 25_000].entries()) {
      const claimed = await queue.claim("worker-a"); assert.ok(claimed); assert.equal(claimed.attempts, index + 1);
      const failed = await queue.fail(leaseFor(claimed), "fixture failure " + (index + 1));
      assert.equal(failed.status, "retry"); assert.equal(failed.attempts, index + 1);
      assert.equal(failed.leaseToken, null); assert.equal(failed.finishedAt, null);
      assert.ok(Math.abs((await retryDelay(job.id)) - expectedDelay) < 200);
      assert.equal(await queue.claim("worker-b"), null); await ready(job.id);
    }
    const last = await queue.claim("worker-a"); assert.ok(last); assert.equal(last.attempts, 4);
    const exhausted = await queue.fail(leaseFor(last), "final fixture failure");
    assert.equal(exhausted.status, "dead"); assert.equal(exhausted.lastError, "final fixture failure");
    assert.ok(exhausted.finishedAt); assert.equal(await queue.claim("worker-b"), null);
  });
  test("non-retryable failures go directly to the dead-letter state", async () => {
    await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "permanent-failure" });
    const claimed = await queue.claim("worker-a"); assert.ok(claimed);
    const failed = await queue.fail(leaseFor(claimed), "fixture validation failure", { retryable: false });
    assert.equal(failed.status, "dead"); assert.equal(failed.attempts, 1); assert.ok(failed.finishedAt);
    assert.equal(await queue.claim("worker-b"), null);
  });
  test("expired leases recover through retry limits and reject the former owner", async () => {
    await queue.enqueue({ type: "reconcile_identity", payload: {}, idempotencyKey: "recovery", maxAttempts: 2, retryBackoffMs: 1_000 });
    const first = await queue.claim("worker-a"); assert.ok(first); assert.deepEqual(await queue.recoverExpired(), []);
    await expire(first.id);
    const [recovered] = await queue.recoverExpired();
    assert.equal(recovered.id, first.id); assert.equal(recovered.status, "retry"); assert.equal(recovered.attempts, 1);
    assert.ok(Math.abs((await retryDelay(first.id)) - 1_000) < 200);
    const stale = leaseFor(first);
    await assert.rejects(queue.complete(stale), LeaseLostError); await assert.rejects(queue.renewLease(stale), LeaseLostError);
    await ready(first.id);
    const second = await queue.claim("worker-b"); assert.ok(second);
    assert.notEqual(second.leaseToken, first.leaseToken); assert.equal(second.attempts, 2);
    await assert.rejects(queue.fail(stale, "former worker"), LeaseLostError);
    await expire(second.id);
    const [dead] = await queue.recoverExpired(); assert.equal(dead.status, "dead"); assert.equal(dead.attempts, 2);
    assert.ok(dead.finishedAt); assert.equal(await queue.claim("worker-c"), null);
  });
  test("recovery is bounded and safe when recovery processes run concurrently", async () => {
    const leases: Job[] = [];
    for (let index = 0; index < 5; index += 1) {
      await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "bounded-recovery-" + index });
      const claimed = await queue.claim("worker-a"); assert.ok(claimed); leases.push(claimed); await expire(claimed.id);
    }
    const first = await queue.recoverExpired({ limit: 1 }); assert.equal(first.length, 1);
    const concurrent = await Promise.all([queue.recoverExpired({ limit: 2 }), queue.recoverExpired({ limit: 2 })]);
    const recovered = [...first, ...concurrent.flat()];
    assert.equal(recovered.length, 5); assert.equal(new Set(recovered.map((job) => job.id)).size, 5);
    assert.deepEqual(new Set(recovered.map((job) => job.id)), new Set(leases.map((job) => job.id)));
    assert.deepEqual(await queue.recoverExpired(), []);
  });
  test("invalid queue parameters fail without creating durable jobs", async () => {
    for (const input of [{ idempotencyKey: "", maxAttempts: 1 }, { idempotencyKey: "invalid-attempts", maxAttempts: 0 },
      { idempotencyKey: "invalid-delay", retryBackoffMs: -1 }, { idempotencyKey: "invalid-cap", retryBackoffMs: 10, retryMaxBackoffMs: 1 }]) {
      await assert.rejects(queue.enqueue({ type: "ingest_batch", payload: {}, ...input }), QueueValidationError);
    }
    await assert.rejects(queue.claim(""), QueueValidationError);
    await assert.rejects(queue.claim("worker", { leaseDurationMs: 0 }), QueueValidationError);
    await assert.rejects(queue.recoverExpired({ limit: 0 }), QueueValidationError);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count, 0);
  });
  test("PostgreSQL rejects malformed job state and lease invariants", async () => {
    const { job } = await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "database-invariants" });
    for (const sql of ["UPDATE jobs SET status = 'unknown' WHERE job_id = $1", "UPDATE jobs SET status = 'leased' WHERE job_id = $1",
      "UPDATE jobs SET attempts = -1 WHERE job_id = $1"]) {
      await assert.rejects(fixture.pool.query(sql, [job.id]), (error: unknown) => (error as { code?: string }).code === "23514");
    }
    assert.equal((await queue.get(job.id))?.status, "queued");
  });
  test("job identity and enqueue contract are immutable without blocking lease transitions", async () => {
    const { job } = await queue.enqueue({ type: "ingest_batch", payload: { synthetic: true }, idempotencyKey: "immutable-envelope" });
    const original = await queue.get(job.id);
    for (const sql of [
      "UPDATE jobs SET job_id = gen_random_uuid() WHERE job_id = $1",
      "UPDATE jobs SET type = 'verify_contact' WHERE job_id = $1",
      "UPDATE jobs SET payload = '{\"changed\":true}'::jsonb WHERE job_id = $1",
      "UPDATE jobs SET idempotency_key = 'changed-envelope' WHERE job_id = $1",
      "UPDATE jobs SET max_attempts = max_attempts + 1 WHERE job_id = $1",
      "UPDATE jobs SET retry_backoff_ms = retry_backoff_ms + 1 WHERE job_id = $1",
      "UPDATE jobs SET retry_max_backoff_ms = retry_max_backoff_ms + 1 WHERE job_id = $1",
      "UPDATE jobs SET scheduled_at = clock_timestamp() WHERE job_id = $1",
      "UPDATE jobs SET created_at = created_at + interval '1 second' WHERE job_id = $1"]) {
      await assert.rejects(fixture.pool.query(sql, [job.id]), (error: unknown) => (error as { code?: string }).code === "23514");
      assert.deepEqual(await queue.get(job.id), original);
    }
    const claimed = await queue.claim("worker-a"); assert.ok(claimed);
    assert.equal((await queue.complete(leaseFor(claimed))).status, "succeeded");
  });
  test("lease mutations recheck expiry after waiting for a row lock", async () => {
    const operations = [
      (lease: JobLease) => queue.complete(lease),
      (lease: JobLease) => queue.fail(lease, "blocked fixture failure"),
      (lease: JobLease) => queue.renewLease(lease, 30_000),
    ];
    for (const [index, operation] of operations.entries()) {
      await queue.enqueue({ type: "verify_contact", payload: {}, idempotencyKey: "lock-wait-fence-" + index });
      const claimed = await queue.claim("worker-a", { leaseDurationMs: 1_000 }); assert.ok(claimed);
      const locker = await fixture.pool.connect();
      let pending: Promise<{ ok: boolean; error: unknown }> | undefined;
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT job_id FROM jobs WHERE job_id = $1 FOR UPDATE", [claimed.id]);
        const owner = await locker.query<{ pid: number; unexpired: boolean }>(
          "SELECT pg_backend_pid() AS pid, lease_expires_at > clock_timestamp() AS unexpired FROM jobs WHERE job_id = $1", [claimed.id]);
        assert.equal(owner.rows[0].unexpired, true);
        pending = operation(leaseFor(claimed)).then(() => ({ ok: true, error: null }), (error: unknown) => ({ ok: false, error }));
        let waiting = false;
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const activity = await fixture.pool.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting", [owner.rows[0].pid]);
          if (activity.rows[0].waiting) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, "queue mutation must actually wait on the external row lock");
        await locker.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp()))) + 0.05) FROM jobs WHERE job_id = $1", [claimed.id]);
        await locker.query("COMMIT");
        const result = await pending; assert.equal(result.ok, false); assert.ok(result.error instanceof LeaseLostError);
        assert.equal((await queue.get(claimed.id))?.status, "leased");
      } finally { await locker.query("ROLLBACK"); locker.release(); if (pending) await pending; }
      // Other expired leased jobs stay ineligible while each operation is tested.
    }
  });
  test("queue statistics report durable states and scheduled eligibility", async () => {
    const empty = await queue.stats();
    assert.equal(empty.total, 0); assert.equal(empty.oldestReadyAt, null);
    await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "stats-success" });
    const success = await queue.claim("worker-a"); assert.ok(success); await queue.complete(leaseFor(success));
    await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "stats-dead" });
    const dead = await queue.claim("worker-a"); assert.ok(dead); await queue.fail(leaseFor(dead), "fixture", { retryable: false });
    await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "stats-retry", retryBackoffMs: 60_000 });
    const retry = await queue.claim("worker-a"); assert.ok(retry); await queue.fail(leaseFor(retry), "fixture");
    await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "stats-leased" });
    const leased = await queue.claim("worker-a"); assert.ok(leased); await expire(leased.id);
    await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "stats-future", availableAt: new Date("2099-01-01T00:00:00.000Z") });
    await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "stats-ready" });
    const stats = await queue.stats();
    assert.deepEqual({ ...stats, oldestReadyAt: null }, { queued: 2, leased: 1, succeeded: 1, retry: 1, dead: 1, total: 6, ready: 1, expiredLeases: 1, oldestReadyAt: null });
    assert.ok(stats.oldestReadyAt instanceof Date);
  });
});
