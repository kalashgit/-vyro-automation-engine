import assert from "node:assert/strict";
import { test } from "node:test";
import { requireTestDatabaseUrl } from "./helpers/database.ts";
test("integration database guard permits only explicit disposable local test databases", () => {
  const safeUrl = "postgresql://test:test@127.0.0.1:5432/vyro_test";
  assert.equal(requireTestDatabaseUrl(safeUrl), safeUrl);
  for (const value of ["", "not a URL", "https://localhost/vyro_test",
    "postgresql://test:test@database.example.com/vyro_test",
    "postgresql://test:test@localhost/vyro", "postgresql://test:test@localhost/postgres",
    "postgresql://test:test@localhost/vyro_test?host=database.example.com",
    "postgresql://test:test@localhost/vyro_test?options=-csearch_path=public"]) {
    assert.throws(() => requireTestDatabaseUrl(value));
  }
});
