import { getDatabasePool } from "../src/modules/database/client.ts";
import { runWorker } from "../src/modules/workers/worker.ts";
import { createAcquisitionHandlers } from "../src/modules/workers/acquisition-handlers.ts";

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
    pool = getDatabasePool();
    // Explicit opt-in: no live job claims before integration tests and operator approval.
    const handlers = process.env.ACQUISITION_HANDLERS_ENABLED === "true"
      ? createAcquisitionHandlers(pool) : {};
    await runWorker(pool, { handlers, signal: controller.signal });
  } catch {
    console.error("Worker process stopped after an internal error.");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool?.end();
  }
}