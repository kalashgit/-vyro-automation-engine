import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run with npm run test:smoke.");
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function launch(auth) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath,
    [npmCli, "start", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
        // HTTP fixtures never connect to a developer's or production database.
        DATABASE_URL: "", ADMIN_USERNAME: auth?.username ?? "", ADMIN_PASSWORD: auth?.password ?? "",
      },
    });
  let logs = "";
  let ended = false;
  let startError;
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk) => { logs = (logs + chunk.toString()).slice(-16000); });
  }
  const finished = new Promise((resolve) => {
    server.once("error", (error) => { startError = error; ended = true; resolve(); });
    server.once("exit", () => { ended = true; resolve(); });
  });
  const request = (path, authorization) => fetch(`${base}${path}`, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: authorization ? { Authorization: authorization } : {},
  });
  async function stop() {
    if (!server.pid) return;
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
        killer.once("error", resolve); killer.once("exit", resolve);
      });
    } else {
      try { process.kill(-server.pid, "SIGTERM"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await Promise.race([finished, delay(5000, undefined, { ref: false })]);
    if (!ended) {
      if (process.platform === "win32") server.kill("SIGKILL");
      else {
        try { process.kill(-server.pid, "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await finished;
    }
  }
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (startError) throw startError;
      if (ended) throw new Error("Production server exited during startup.");
      try {
        const response = await request("/api/health");
        await response.arrayBuffer();
        if (response.ok) return { request, stop, logs: () => logs };
      } catch { /* A new server may briefly refuse connections. */ }
      await delay(250);
    }
    throw new Error("Production server startup timed out.");
  } catch (error) { console.error(logs); await stop(); throw error; }
}

async function health(request) {
  const response = await request("/api/health");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "vyro-automation-engine");
  assert.equal(body.version, version);
  assert.equal(new Date(body.timestamp).toISOString(), body.timestamp);
  assert.ok(Math.abs(Date.now() - Date.parse(body.timestamp)) < 30000);
  return body;
}

const unconfigured = await launch();
try {
  await health(unconfigured.request);
  const response = await unconfigured.request("/");
  assert.equal(response.status, 503, "Missing admin configuration must fail closed.");
  await response.arrayBuffer();
} finally { await unconfigured.stop(); }

const credentials = { username: "smoke-admin", password: randomBytes(24).toString("hex") };
const authorization = "Basic " + Buffer.from(credentials.username + ":" + credentials.password).toString("base64");
const configured = await launch(credentials);
try {
  for (const path of ["/", "/enrichment", "/api/enrichment", "/api/readiness", "/api/future-admin-endpoint"]) {
    const response = await configured.request(path);
    assert.equal(response.status, 401, "Admin routes must require authentication.");
    assert.match(response.headers.get("www-authenticate") ?? "", /Basic/i);
    await response.arrayBuffer();
  }
  for (const invalid of ["Bearer irrelevant", "Basic !!!", "Basic " + Buffer.from("wrong:wrong").toString("base64")]) {
    const response = await configured.request("/", invalid);
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  const page = await configured.request("/", authorization);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/i);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-powered-by"), null);
  const html = await page.text();
  for (const label of ["VYRO Automation Engine", "Engine Status", "NOT OPERATIONAL",
    "Queue Status", "Workers", "Watchdog", "Last heartbeat", "automation control plane",
    "customer storefront", "NOT CONFIGURED"]) {
    assert.ok(html.toLowerCase().includes(label.toLowerCase()), `Missing dashboard content: ${label}`);
  }
  const heartbeat = html.match(/<time[^>]*datetime="([^"]+)"/i)?.[1];
  assert.ok(heartbeat && Math.abs(Date.now() - Date.parse(heartbeat)) < 30000);
  const enrichmentPage = await configured.request("/enrichment", authorization);
  assert.equal(enrichmentPage.status, 200);
  assert.match(await enrichmentPage.text(), /Enrichment results/);
  const enrichment = await configured.request("/api/enrichment", authorization);
  assert.equal(enrichment.status, 503);
  assert.equal((await enrichment.json()).error, "ENRICHMENT_DATABASE_UNAVAILABLE");
  const invalidOffset = await configured.request("/api/enrichment?offset=-1", authorization);
  assert.equal(invalidOffset.status,400); await invalidOffset.arrayBuffer();
  const readiness = await configured.request("/api/readiness", authorization);
  assert.equal(readiness.status, 503);
  assert.match(readiness.headers.get("cache-control") ?? "", /no-store/i);
  const readyBody = await readiness.json();
  assert.equal(readyBody.status, "not_ready");
  assert.equal(readyBody.engine, "not_operational");
  assert.equal(readyBody.checks.database, "not_configured");
  assert.equal(readyBody.checks.worker, "not_configured");
  const first = await health(configured.request);
  await delay(1100);
  const second = await health(configured.request);
  assert.notEqual(second.timestamp, first.timestamp);
  const missing = await configured.request("/phase-one-route-that-does-not-exist", authorization);
  await missing.arrayBuffer();
  assert.equal(missing.status, 404);
  console.log("Smoke checks passed: fail-closed admin config, API auth, dashboard, public fresh liveness, not-ready engine, security headers, and 404.");
} catch (error) { console.error(configured.logs()); throw error; }
finally { await configured.stop(); }
