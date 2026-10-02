import { getDatabasePool } from "../src/modules/database/client.ts";
import { runWatchdog } from "../src/modules/workers/watchdog.ts";

if (process.env.WATCHDOG_ENABLED !== "true") {
  console.error("Watchdog is disabled. Set WATCHDOG_ENABLED=true to start this process.");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let pool;
  try {
    pool = getDatabasePool();
    await runWatchdog(pool, {
      signal: controller.signal,
      onRecovered: (count) => console.info("Recovered expired queue leases:", count),
    });
  } catch {
    console.error("Watchdog process stopped after an internal error.");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool?.end();
  }
}