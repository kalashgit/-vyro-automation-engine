import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

interface Migration { filename: string; content: string; checksum: string; }
interface MigrationRow { filename: string; checksum: string; }
const defaultMigrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
async function readMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).map((entry) => entry.name).sort();
  if (filenames.length === 0) throw new Error("No SQL migrations were found.");
  const versions = new Set<string>();
  return Promise.all(filenames.map(async (filename) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(filename)) throw new Error("Migration filenames must use 0001_description.sql format.");
    const version = filename.slice(0, 4);
    if (versions.has(version)) throw new Error("Migration version numbers must be unique.");
    versions.add(version);
    const content = await readFile(join(directory, filename), "utf8");
    return { filename, content, checksum: createHash("sha256").update(content).digest("hex") };
  }));
}
/** Explicit administrative migrations; session lock, per-file transaction and checksum ledger. */
export async function applyMigrations(pool: Pool, migrationsDirectory = defaultMigrationsDirectory): Promise<string[]> {
  const migrations = await readMigrations(migrationsDirectory);
  const client = await pool.connect();
  const applied: string[] = [];
  let locked = false;
  let transactionStarted = false;
  let discardConnection = false;
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [19790426, 1]);
    locked = true;
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'), applied_at timestamptz NOT NULL DEFAULT clock_timestamp())");
    const ledger = await client.query<MigrationRow>("SELECT filename, checksum FROM schema_migrations ORDER BY filename");
    for (let index = 0; index < ledger.rows.length; index += 1) {
      const recorded = ledger.rows[index];
      const source = migrations[index];
      if (!source || source.filename !== recorded.filename) throw new Error("Applied migration history is missing or has been reordered.");
      if (source.checksum !== recorded.checksum) throw new Error("Applied migration checksum changed: " + recorded.filename);
    }
    await client.query("COMMIT");
    transactionStarted = false;
    for (const migration of migrations.slice(ledger.rows.length)) {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(migration.content);
      await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [migration.filename, migration.checksum]);
      await client.query("COMMIT");
      transactionStarted = false;
      applied.push(migration.filename);
    }
    return applied;
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { discardConnection = true; }
    }
    throw error;
  } finally {
    if (locked && !discardConnection) {
      try { await client.query("SELECT pg_advisory_unlock($1, $2)", [19790426, 1]); }
      catch { discardConnection = true; }
    }
    client.release(discardConnection);
  }
}
