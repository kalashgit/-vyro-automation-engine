import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

const publicPaths = new Set(["/api/health", "/api/health/database", "/api/unsubscribe"]);

export function proxy(request: NextRequest) {
  if (publicPaths.has(request.nextUrl.pathname)) return NextResponse.next();
  const denied = requireAdmin(request);
  if (denied) return denied;
  return NextResponse.next({ headers: { "Cache-Control": "no-store" } });
}
export const config = { matcher: ["/", "/review", "/enrichment", "/api/:path*"] };
