import { getDatabasePool } from "../src/modules/database/client.ts";
import { runWorker } from "../src/modules/workers/worker.ts";

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
    await runWorker(pool, { handlers: {}, signal: controller.signal });
  } catch {
    console.error("Worker process stopped after an internal error.");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool?.end();
  }
}