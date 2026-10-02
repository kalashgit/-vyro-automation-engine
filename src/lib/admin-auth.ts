import { createHash, timingSafeEqual } from "node:crypto";

type AdminEnvironment = Readonly<Record<string, string | undefined>>;
function credentials(environment: AdminEnvironment) {
  const username = environment.ADMIN_USERNAME;
  const password = environment.ADMIN_PASSWORD;
  if (!username || username.length > 128 || /[:\u0000-\u0020\u007f]/u.test(username) || !password || password.length < 16 || password.length > 1024) return null;
  return { username, password };
}
export function isAdminConfigured(environment: AdminEnvironment = process.env): boolean { return credentials(environment) !== null; }
function matches(actual: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}
function parseBasic(header: string | null) {
  if (!header || header.length > 8192) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.toString("base64") !== match[1]) return null;
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}
export function requireAdmin(request: Request, environment: AdminEnvironment = process.env): Response | null {
  const expected = credentials(environment);
  if (!expected) return Response.json({ status: "not_configured", error: "Admin access is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const actual = parseBasic(request.headers.get("authorization"));
  if (actual) {
    const usernameMatches = matches(actual.username, expected.username);
    const passwordMatches = matches(actual.password, expected.password);
    if (usernameMatches && passwordMatches) return null;
  }
  return Response.json({ status: "unauthorized", error: "Authentication required." }, { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": 'Basic realm="VYRO control plane", charset="UTF-8"' } });
}
