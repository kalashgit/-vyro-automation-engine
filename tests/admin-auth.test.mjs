import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { isAdminConfigured, requireAdmin } from "../src/lib/admin-auth.ts";
const environment = { ADMIN_USERNAME: "operator", ADMIN_PASSWORD: randomBytes(24).toString("hex") };
function request(header) {
  return new Request("https://example.test/", { headers: header ? { Authorization: header } : {} });
}
function basic(username, password) { return "Basic " + Buffer.from(username + ":" + password).toString("base64"); }
test("admin access fails closed when configuration is absent or invalid", () => {
  for (const env of [{}, { ...environment, ADMIN_USERNAME: "" }, { ...environment, ADMIN_USERNAME: "a:b" },
    { ...environment, ADMIN_USERNAME: "a b" }, { ...environment, ADMIN_PASSWORD: "short" }]) {
    assert.equal(isAdminConfigured(env), false);
    const response = requireAdmin(request(), env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("www-authenticate"), null);
  }
});
test("missing and incorrect credentials are rejected without exposing secrets", async () => {
  for (const header of [undefined, basic("wrong", environment.ADMIN_PASSWORD),
    basic(environment.ADMIN_USERNAME, "wrong"), "Bearer fixture", "Basic !!!", "Basic " + Buffer.from("no-colon").toString("base64")]) {
    const response = requireAdmin(request(header), environment);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /^Basic /);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.text()).includes(environment.ADMIN_PASSWORD), false);
  }
});
test("valid credentials and passwords containing colons authenticate", () => {
  assert.equal(isAdminConfigured(environment), true);
  assert.equal(requireAdmin(request(basic(environment.ADMIN_USERNAME, environment.ADMIN_PASSWORD)), environment), null);
  const env = { ...environment, ADMIN_PASSWORD: environment.ADMIN_PASSWORD + ":suffix" };
  assert.equal(requireAdmin(request(basic(env.ADMIN_USERNAME, env.ADMIN_PASSWORD)), env), null);
});
test("ambiguous base64 and invalid UTF-8 cannot authenticate", () => {
  for (const header of [basic(environment.ADMIN_USERNAME, environment.ADMIN_PASSWORD) + "=",
    "Basic " + Buffer.from([0xff, 0x3a, 0xff]).toString("base64"), "Basic " + "A".repeat(8192)]) {
    assert.equal(requireAdmin(request(header), environment).status, 401);
  }
});
