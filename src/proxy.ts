import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  const denied = requireAdmin(request);
  if (denied) return denied;
  return NextResponse.next({ headers: { "Cache-Control": "no-store" } });
}
export const config = { matcher: ["/", "/api/:path*"] };
