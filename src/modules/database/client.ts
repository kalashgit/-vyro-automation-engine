import pg from "pg";
import type { Pool, PoolClient } from "pg";

export type DatabaseSslMode = "verify-full" | "disable";
export interface DatabaseOptions {
  connectionString: string;
  max?: number;
  sslMode?: DatabaseSslMode;
  sslCa?: string;
}
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const sslUrlParameters = ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"];
function validatedConnectionUrl(connectionString: string): URL {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length <= 1) {
    throw new Error("DATABASE_URL must identify a PostgreSQL host and database.");
  }
  if (sslUrlParameters.some((key) => url.searchParams.has(key))) {
    throw new Error("Configure PostgreSQL TLS with DATABASE_SSL_MODE and DATABASE_SSL_CA; remove SSL parameters from DATABASE_URL.");
  }
  return url;
}
export function isDatabaseConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.DATABASE_URL?.trim());
}
export function createDatabasePool(options: DatabaseOptions): Pool {
  const url = validatedConnectionUrl(options.connectionString);
  const sslMode = options.sslMode ?? "verify-full";
  if (sslMode !== "verify-full" && sslMode !== "disable") throw new Error("DATABASE_SSL_MODE must be verify-full or disable.");
  if (sslMode === "disable" && !loopbackHosts.has(url.hostname.toLowerCase())) {
    throw new Error("DATABASE_SSL_MODE=disable is allowed only for a loopback PostgreSQL host.");
  }
  const max = options.max ?? 5;
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error("PostgreSQL pool size must be an integer between 1 and 50.");
  const pool = new pg.Pool({
    connectionString: options.connectionString, max,
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: true, ...(options.sslCa ? { ca: options.sslCa } : {}) },
  });
  pool.on("error", () => {
    process.emitWarning("An idle PostgreSQL connection failed.", { code: "VYRO_DATABASE_CONNECTION" });
  });
  return pool;
}
let sharedPool: Pool | undefined;
export function getDatabasePool(): Pool {
  if (sharedPool) return sharedPool;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required to use persistent storage.");
  const sslMode = process.env.DATABASE_SSL_MODE ?? "verify-full";
  if (sslMode !== "verify-full" && sslMode !== "disable") throw new Error("DATABASE_SSL_MODE must be verify-full or disable.");
  sharedPool = createDatabasePool({ connectionString, sslMode, sslCa: process.env.DATABASE_SSL_CA });
  return sharedPool;
}
export async function withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discardConnection = false;
  let transactionStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    transactionStarted = true;
    const result = await operation(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { discardConnection = true; }
    }
    throw error;
  } finally { client.release(discardConnection); }
}
