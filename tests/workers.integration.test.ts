import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { applyMigrations } from "../src/modules/database/migrate.ts";
import { createQueue } from "../src/modules/queue/queue.ts";
import { getProcessAvailability } from "../src/modules/workers/heartbeat.ts";
import { runWatchdog } from "../src/modules/workers/watchdog.ts";
import { runWorker } from "../src/modules/workers/worker.ts";
import { createDatabaseFixture } from "./helpers/database.ts";
import type { DatabaseFixture } from "./helpers/database.ts";

describe("independent queue worker and watchdog", { concurrency: false }, () => {
  let fixture: DatabaseFixture;
  let queue: ReturnType<typeof createQueue>;
  before(async () => {
    fixture = await createDatabaseFixture();
    await applyMigrations(fixture.pool);
    queue = createQueue(fixture.pool);
  });
  after(async () => { if (fixture) await fixture.dispose(); });
  beforeEach(async () => {
    await fixture.pool.query("DELETE FROM jobs; TRUNCATE worker_processes");
  });

  async function until(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("Timed out waiting for the worker process state.");
  }

  test("worker only claims registered job types and records a clean shutdown", async () => {
    const handled = await queue.enqueue({ type: "ingest_batch", payload: {}, idempotencyKey: "worker-handled" });
    const untouched = await queue.enqueue({ type: "prepare_outreach", payload: {}, idempotencyKey: "worker-outreach-unhandled" });
    const controller = new AbortController();
    const worker = runWorker(fixture.pool, {
      handlers: { ingest_batch: async () => undefined },
      signal: controller.signal,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 100,
    });

    await until(async () => (await queue.get(handled.job.id))?.status === "succeeded");
    controller.abort();
    await worker;

    assert.equal((await queue.get(untouched.job.id))?.status, "queued");
    const statuses = await getProcessAvailability(fixture.pool);
    assert.equal(statuses.worker, "unavailable");
    assert.equal(statuses.watchdog, "not_configured");
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM worker_processes WHERE kind = 'worker' AND stopped_at IS NOT NULL")).rows[0].count, 1);
  });

  test("worker with no handlers stays idle without claiming outreach jobs", async () => {
    const pending = await queue.enqueue({ type: "prepare_outreach", payload: {}, idempotencyKey: "worker-empty-registry" });
    const controller = new AbortController();
    const worker = runWorker(fixture.pool, {
      handlers: {},
      signal: controller.signal,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 100,
    });
    await until(async () => (await fixture.pool.query("SELECT count(*)::int AS count FROM worker_processes WHERE kind = 'worker'")).rows[0].count === 1);
    controller.abort();
    await worker;
    assert.equal((await queue.get(pending.job.id))?.status, "queued");
  });

  test("worker renews active leases and does not persist raw handler errors", async () => {
    const pending = await queue.enqueue({ type: "verify_contact", payload: {}, idempotencyKey: "worker-lease-renewal", maxAttempts: 1 });
    let releaseHandler: (() => void) | undefined;
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const hold = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const controller = new AbortController();
    const worker = runWorker(fixture.pool, {
      handlers: { verify_contact: async () => { handlerStarted?.(); await hold; throw new Error("private payload must not be persisted"); } },
      signal: controller.signal,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 100,
    });
    await started;
    const initialHeartbeat = (await queue.get(pending.job.id))?.heartbeatAt?.getTime();
    await until(async () => {
      const heartbeat = (await queue.get(pending.job.id))?.heartbeatAt?.getTime();
      return Boolean(initialHeartbeat && heartbeat && heartbeat > initialHeartbeat);
    });
    releaseHandler?.();
    await until(async () => (await queue.get(pending.job.id))?.status === "dead");
    controller.abort();
    await worker;
    const failed = await queue.get(pending.job.id);
    assert.equal(failed?.lastError, "Job execution failed: HANDLER_FAILED");
    assert.equal(failed?.lastError?.includes("private payload"), false);
  });

  test("watchdog recovers expired leases and records its heartbeat", async () => {
    const pending = await queue.enqueue({ type: "reconcile_identity", payload: {}, idempotencyKey: "watchdog-recovery" });
    const lease = await queue.claim("fixture-worker");
    assert.ok(lease);
    await fixture.pool.query("UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE job_id = $1", [pending.job.id]);

    const controller = new AbortController();
    const watchdog = runWatchdog(fixture.pool, { signal: controller.signal, pollIntervalMs: 5, recoveryLimit: 1 });
    await until(async () => (await queue.get(pending.job.id))?.status === "retry");
    controller.abort();
    await watchdog;

    const recovered = await queue.get(pending.job.id);
    assert.equal(recovered?.attempts, 1);
    assert.equal((await getProcessAvailability(fixture.pool)).watchdog, "unavailable");
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM worker_processes WHERE kind = 'watchdog' AND stopped_at IS NOT NULL")).rows[0].count, 1);
  });
});
