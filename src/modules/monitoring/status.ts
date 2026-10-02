import "server-only";
import { getDatabasePool, isDatabaseConfigured } from "@/modules/database/client";
import { createQueue } from "@/modules/queue/queue";

type QueueSnapshot = Awaited<ReturnType<ReturnType<typeof createQueue>["stats"]>>;
export type ControlPlaneSnapshot = {
  database: "ready" | "not_configured" | "unavailable";
  queue: QueueSnapshot | null;
};
export async function getControlPlaneSnapshot(): Promise<ControlPlaneSnapshot> {
  if (!isDatabaseConfigured()) return { database: "not_configured", queue: null };
  try {
    const queue = await createQueue(getDatabasePool()).stats();
    return { database: "ready", queue };
  } catch { return { database: "unavailable", queue: null }; }
}
