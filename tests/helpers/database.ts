import { randomUUID } from "node:crypto";
import pg from "pg";

export function requireTestDatabaseUrl(value = process.env.TEST_DATABASE_URL): string {
  if (!value) throw new Error("TEST_DATABASE_URL is required; never use DATABASE_URL for integration tests.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("TEST_DATABASE_URL must be a valid local PostgreSQL URL."); }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !localHosts.has(url.hostname) ||
      !/^[a-zA-Z0-9_]+_test$/.test(database) || url.search || url.hash) {
    throw new Error("TEST_DATABASE_URL must target localhost and a database ending in _test, without query parameters.");
  }
  return value;
}
export async function createDatabaseFixture() {
  const connectionString = requireTestDatabaseUrl();
  const schema = "vyro_test_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString, max: 1 });
  try { await admin.query('CREATE SCHEMA "' + schema + '"'); }
  catch (error) { await admin.end(); throw error; }
  const pool = new pg.Pool({
    connectionString, max: 12,
    options: "-c search_path=" + schema + " -c statement_timeout=10000 -c lock_timeout=5000",
  });
  let disposed = false;
  return {
    pool, schema,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await pool.end(); await admin.query('DROP SCHEMA "' + schema + '" CASCADE'); }
      finally { await admin.end(); }
    },
  };
}
export type DatabaseFixture = Awaited<ReturnType<typeof createDatabaseFixture>>;
