import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { withTransaction } from "../src/modules/database/client.ts";
import { applyMigrations } from "../src/modules/database/migrate.ts";
import { createDatabaseFixture } from "./helpers/database.ts";
const sourceMigrations = fileURLToPath(new URL("../migrations/", import.meta.url));
async function copiedMigrations() {
  const directory = await mkdtemp(join(tmpdir(), "vyro-migrations-test-"));
  await cp(sourceMigrations, directory, { recursive: true });
  return directory;
}
test("migrations are repeatable and concurrent runners apply each file once", async () => {
  const fixture = await createDatabaseFixture();
  try {
    const results = await Promise.all([applyMigrations(fixture.pool), applyMigrations(fixture.pool)]);
    const applied = results.flat();
    assert.ok(applied.length > 0);
    assert.equal(new Set(applied).size, applied.length);
    assert.deepEqual(await applyMigrations(fixture.pool), []);
    const ledger = await fixture.pool.query<{ filename: string; checksum: string; applied_at: Date }>(
      "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename");
    assert.deepEqual(ledger.rows.map((row) => row.filename), [...applied].sort());
    assert.ok(ledger.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)));
    assert.ok(ledger.rows.every((row) => row.applied_at instanceof Date));
  } finally { await fixture.dispose(); }
});
test("an applied migration's changed checksum is rejected before applying new SQL", async () => {
  const fixture = await createDatabaseFixture();
  const directory = await copiedMigrations();
  try {
    await applyMigrations(fixture.pool, directory);
    const filenames = (await readdir(directory)).filter((filename) => filename.endsWith(".sql")).sort();
    assert.ok(filenames.length > 0);
    const first = join(directory, filenames[0]);
    await writeFile(first, (await readFile(first, "utf8")) + "\n-- altered after application\n");
    await writeFile(join(directory, "9999_checksum_probe.sql"), "CREATE TABLE checksum_probe (id integer);\n");
    await assert.rejects(applyMigrations(fixture.pool, directory), /checksum|changed|modified/i);
    const result = await fixture.pool.query<{ name: string | null }>("SELECT to_regclass('checksum_probe')::text AS name");
    assert.equal(result.rows[0].name, null);
  } finally { await fixture.dispose(); await rm(directory, { recursive: true, force: true }); }
});
test("failed migration SQL rolls back its entire file and can be retried", async () => {
  const fixture = await createDatabaseFixture();
  const directory = await copiedMigrations();
  const filename = "9999_rollback_probe.sql";
  try {
    await applyMigrations(fixture.pool, directory);
    await writeFile(join(directory, filename),
      "CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);\nINSERT INTO missing_migration_table VALUES (1);\n");
    await assert.rejects(applyMigrations(fixture.pool, directory));
    const result = await fixture.pool.query<{ name: string | null }>("SELECT to_regclass('migration_rollback_probe')::text AS name");
    assert.equal(result.rows[0].name, null);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE filename = $1", [filename])).rows[0].count, 0);
    await writeFile(join(directory, filename),
      "CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);\nINSERT INTO migration_rollback_probe VALUES (1);\n");
    assert.deepEqual(await applyMigrations(fixture.pool, directory), [filename]);
    assert.equal((await fixture.pool.query("SELECT id FROM migration_rollback_probe")).rows[0].id, 1);
    assert.deepEqual(await applyMigrations(fixture.pool, directory), []);
  } finally { await fixture.dispose(); await rm(directory, { recursive: true, force: true }); }
});
test("database transaction helper rolls back callback failures and preserves reusable connections", async () => {
  const fixture = await createDatabaseFixture();
  try {
    await applyMigrations(fixture.pool);
    const sentinel = new Error("intentional transaction rollback fixture");
    await assert.rejects(withTransaction(fixture.pool, async (client) => {
      await client.query("INSERT INTO jobs (type, payload, idempotency_key) VALUES ('ingest_batch', '{}'::jsonb, 'rolled-back-job')");
      throw sentinel;
    }), (error: unknown) => error === sentinel);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count, 0);
    const returned = await withTransaction(fixture.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        "INSERT INTO jobs (type, payload, idempotency_key) VALUES ('ingest_batch', '{}'::jsonb, 'committed-job') RETURNING job_id AS id");
      return result.rows[0].id;
    });
    assert.ok(returned);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count, 1);
  } finally { await fixture.dispose(); }
});
test("prospect identities and immutable original provenance are enforced by PostgreSQL", async () => {
  const fixture = await createDatabaseFixture();
  try {
    await applyMigrations(fixture.pool);
    const batch = await fixture.pool.query<{ batch_id: string }>(
      "INSERT INTO import_batches (source_worker, source_batch, original_source_evidence, raw_discovered_count) VALUES ($1, $2, $3::jsonb, $4) RETURNING batch_id",
      ["test-fixture-worker", "test-fixture-batch", JSON.stringify({ source: "automated-test", synthetic: true }), 5]);
    const batchId = batch.rows[0].batch_id;
    const source = JSON.stringify({ source: "automated-test", synthetic: true });
    await fixture.pool.query(
      "INSERT INTO prospects (record_id, source_batch_id, source_worker, original_source_evidence, canonical_domain) VALUES ($1, $2, $3, $4::jsonb, $5)",
      ["fixture-record-001", batchId, "test-fixture-worker", source, "fixture-one.example"]);
    for (const values of [["fixture-record-001", "other-fixture.example"], ["fixture-record-002", "fixture-one.example"]]) {
      await assert.rejects(fixture.pool.query(
        "INSERT INTO prospects (record_id, source_batch_id, source_worker, original_source_evidence, canonical_domain) VALUES ($1, $2, $3, $4::jsonb, $5)",
        [values[0], batchId, "test-fixture-worker", source, values[1]]),
        (error: unknown) => (error as { code?: string }).code === "23505");
    }
    await fixture.pool.query(
      "INSERT INTO prospects (record_id, source_batch_id, source_worker, original_source_evidence, normalized_company_name, country) VALUES ($1, $2, $3, $4::jsonb, $5, $6)",
      ["fixture-record-003", batchId, "test-fixture-worker", source, "fixture company", "GB"]);
    await assert.rejects(fixture.pool.query(
      "INSERT INTO prospects (record_id, source_batch_id, source_worker, original_source_evidence, normalized_company_name, country, region) VALUES ($1, $2, $3, $4::jsonb, $5, $6, NULL)",
      ["fixture-record-004", batchId, "test-fixture-worker", source, "fixture company", "GB"]),
      (error: unknown) => (error as { code?: string }).code === "23505");
    for (const sql of [
      "UPDATE prospects SET record_id = 'changed' WHERE record_id = 'fixture-record-001'",
      "UPDATE prospects SET source_worker = 'changed' WHERE record_id = 'fixture-record-001'",
      "UPDATE prospects SET original_source_evidence = '{}'::jsonb WHERE record_id = 'fixture-record-001'",
      "UPDATE prospects SET source_batch_id = $1 WHERE record_id = 'fixture-record-001'"]) {
      await assert.rejects(fixture.pool.query(sql, sql.includes("$1") ? [randomUUID()] : []));
    }
    await fixture.pool.query("UPDATE prospects SET category = 'fixture-category', relevance_status = 'relevant', updated_at = clock_timestamp() WHERE record_id = 'fixture-record-001'");
    assert.equal((await fixture.pool.query("SELECT category FROM prospects WHERE record_id = 'fixture-record-001'")).rows[0].category, "fixture-category");
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM prospects")).rows[0].count, 2);
  } finally { await fixture.dispose(); }
});
test("raw discovery/import audit remains separate and immutable", async () => {
  const fixture = await createDatabaseFixture();
  try {
    await applyMigrations(fixture.pool);
    const batch = await fixture.pool.query<{ batch_id: string }>(
      "INSERT INTO import_batches (source_worker, source_batch, original_source_evidence, raw_discovered_count) VALUES ('fixture-worker', 'fixture-batch', '{\"synthetic\":true}'::jsonb, 100) RETURNING batch_id");
    await fixture.pool.query(
      "INSERT INTO import_rows (batch_id, row_number, raw_record_id, raw_payload) VALUES ($1, 1, 'fixture-raw-001', '{\"synthetic\":true}'::jsonb)", [batch.rows[0].batch_id]);
    assert.equal((await fixture.pool.query("SELECT raw_discovered_count::int AS count FROM import_batches")).rows[0].count, 100);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM prospects")).rows[0].count, 0);
    for (const sql of ["UPDATE import_batches SET raw_discovered_count = 101", "DELETE FROM import_batches",
      "TRUNCATE import_batches CASCADE", "UPDATE import_rows SET raw_payload = '{}'::jsonb", "DELETE FROM import_rows", "TRUNCATE import_rows"]) {
      await assert.rejects(fixture.pool.query(sql));
    }
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS count FROM import_rows")).rows[0].count, 1);
    assert.equal((await fixture.pool.query("SELECT raw_discovered_count::int AS count FROM import_batches")).rows[0].count, 100);
  } finally { await fixture.dispose(); }
});
