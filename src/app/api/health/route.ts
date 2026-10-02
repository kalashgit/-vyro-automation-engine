import { getHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getHealth(), {
    headers: { "Cache-Control": "no-store" },
  });
}
