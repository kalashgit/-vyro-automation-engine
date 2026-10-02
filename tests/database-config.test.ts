import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabasePool, isDatabaseConfigured } from "../src/modules/database/client.ts";
test("database URL overrides cannot bypass local-only TLS configuration", () => {
  for (const connectionString of [
    "postgresql://localhost/vyro_test?host=database.example.com",
    "postgresql://localhost/vyro_test?sslmode=no-verify",
    "postgresql://localhost/vyro_test?options=-csearch_path=public",
    "postgresql://localhost/vyro_test#fragment",
    "postgresql://database.example.com/vyro_test",
  ]) {
    assert.throws(() => createDatabasePool({ connectionString, sslMode: "disable" }));
  }
});
test("TLS verifies certificates by default and permits explicit loopback development", async () => {
  const verified = createDatabasePool({ connectionString: "postgresql://database.example.com/vyro_test" });
  const local = createDatabasePool({ connectionString: "postgresql://localhost/vyro_test", sslMode: "disable" });
  try {
    assert.deepEqual(verified.options.ssl, { rejectUnauthorized: true });
    assert.equal(local.options.ssl, false);
    assert.equal(isDatabaseConfigured({}), false);
    assert.equal(isDatabaseConfigured({ DATABASE_URL: "  " }), false);
    assert.equal(isDatabaseConfigured({ DATABASE_URL: "postgresql://localhost/vyro_test" }), true);
  } finally { await Promise.all([verified.end(), local.end()]); }
});
