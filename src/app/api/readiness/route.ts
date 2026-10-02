import { requireAdmin } from "@/lib/admin-auth";
import { getHealth } from "@/lib/health";
import { getControlPlaneSnapshot } from "@/modules/monitoring/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const snapshot = await getControlPlaneSnapshot();
  return Response.json({
    ...getHealth(), status: "not_ready", engine: "not_operational",
    checks: { database: snapshot.database, worker: "not_configured", watchdog: "not_configured" },
    description: "An independent worker has not been deployed and tested.",
  }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
