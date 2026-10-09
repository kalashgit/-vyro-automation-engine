import { getDatabasePool } from "../src/modules/database/client.ts";
import { runWorker } from "../src/modules/workers/worker.ts";
import { createAcquisitionHandlers } from "../src/modules/workers/acquisition-handlers.ts";
import { parseWorkerConcurrency } from "../src/modules/workers/fleet-config.mjs";

if (process.env.WORKER_ENABLED !== "true") {
  console.error("Worker is disabled. Set WORKER_ENABLED=true to start this process.");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let pool;
  try {
    // All loops share the same durable queue and DB pool. Multiple workers
    // claim distinct leased jobs; no new sender or outbound job is registered.
    const concurrency = parseWorkerConcurrency(process.env.WORKER_CONCURRENCY);
    pool = getDatabasePool();
    const handlers = process.env.ACQUISITION_HANDLERS_ENABLED === "true"
      ? createAcquisitionHandlers(pool, { socialEnabled: process.env.SOCIAL_ENRICHMENT_ENABLED === 'true', officialSiteEnabled: process.env.ENRICHMENT_ENABLED === 'true' }) : {};
    const pollIntervalMs = concurrency > 1 ? 5_000 : 1_000;
    const loops = Array.from({ length: concurrency }, () =>
      runWorker(pool, { handlers, signal: controller.signal, pollIntervalMs })
        .catch(error => { controller.abort(error); throw error; })
    );
    const results = await Promise.allSettled(loops);
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  } catch {
    console.error("Worker fleet stopped after an internal error.");
    process.exitCode = 1;
  } finally {
    controller.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool?.end();
  }
}
