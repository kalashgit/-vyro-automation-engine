import "server-only";
import { getDatabasePool, isDatabaseConfigured } from "@/modules/database/client";
import { createQueue } from "@/modules/queue/queue";
import { getProcessAvailability } from "@/modules/workers/heartbeat";

type QueueSnapshot = Awaited<ReturnType<ReturnType<typeof createQueue>["stats"]>>;
export type ControlPlaneSnapshot = {
  database: "ready" | "not_configured" | "unavailable";
  queue: QueueSnapshot | null;
  worker: "ready" | "not_configured" | "unavailable";
  watchdog: "ready" | "not_configured" | "unavailable";
};
export async function getControlPlaneSnapshot(): Promise<ControlPlaneSnapshot> {
  if (!isDatabaseConfigured()) return { database: "not_configured", queue: null, worker: "not_configured", watchdog: "not_configured" };
  try {
    const pool = getDatabasePool();
    const [queue, processes] = await Promise.all([createQueue(pool).stats(), getProcessAvailability(pool)]);
    return { database: "ready", queue, ...processes };
  } catch { return { database: "unavailable", queue: null, worker: "unavailable", watchdog: "unavailable" }; }
}
