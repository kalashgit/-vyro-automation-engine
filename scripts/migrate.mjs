import { getDatabasePool } from "../src/modules/database/client.ts";
import { applyMigrations } from "../src/modules/database/migrate.ts";

let pool;
try {
  pool = getDatabasePool();
  const applied = await applyMigrations(pool);
  console.log(applied.length ? "Applied migrations: " + applied.join(", ") : "Database schema is already current.");
} catch {
  console.error("Database migration failed. Check DATABASE_URL, TLS configuration, database permissions, and unchanged migration history.");
  process.exitCode = 1;
} finally { await pool?.end(); }
