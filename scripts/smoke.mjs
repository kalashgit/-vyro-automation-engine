import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run test:smoke.");
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
});
const port = probe.address().port;
await new Promise((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const base = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [npmCli, "start", "--", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
  },
);
let logs = "";
let ended = false;
let startError;
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    logs = (logs + chunk.toString()).slice(-16000);
  });
}
const finished = new Promise((resolve) => {
  server.once("error", (error) => { startError = error; ended = true; resolve(); });
  server.once("exit", () => { ended = true; resolve(); });
});
const request = (path) =>
  fetch(`${base}${path}`, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });

async function waitUntilReady() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (startError) throw startError;
    if (ended) throw new Error("Production server exited before becoming ready.");
    try {
      const response = await request("/api/health");
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Startup may briefly refuse connections.
    }
    await delay(250);
  }
  throw new Error("Production server did not become ready within 60 seconds.");
}

async function health() {
  const response = await request("/api/health");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "vyro-automation-engine");
  assert.equal(body.version, version);
  assert.equal(typeof body.timestamp, "string");
  const timestamp = Date.parse(body.timestamp);
  assert.ok(Number.isFinite(timestamp), "Health timestamp must be a valid date.");
  assert.equal(new Date(timestamp).toISOString(), body.timestamp);
  assert.ok(Math.abs(Date.now() - timestamp) < 30000, "Health timestamp must be current.");
  return body;
}

async function stopServer() {
  if (!server.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", resolve);
      killer.once("exit", resolve);
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
  await waitUntilReady();
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/i);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-powered-by"), null);
  const html = await page.text();
  for (const label of [
    "VYRO Automation Engine", "Engine Status", "ONLINE", "Queue Status",
    "Workers", "Watchdog", "Last heartbeat", "automation control plane",
    "customer storefront", "NOT CONFIGURED",
  ]) {
    assert.ok(html.toLowerCase().includes(label.toLowerCase()), `Dashboard is missing: ${label}`);
  }
  const heartbeat = html.match(/<time[^>]*datetime="([^"]+)"/i)?.[1];
  assert.ok(heartbeat && Math.abs(Date.now() - Date.parse(heartbeat)) < 30000, "Dashboard heartbeat must be current.");
  const first = await health();
  await delay(1100);
  const second = await health();
  assert.notEqual(second.timestamp, first.timestamp, "Health response must not be cached.");
  const missing = await request("/phase-one-route-that-does-not-exist");
  await missing.arrayBuffer();
  assert.equal(missing.status, 404);
  assert.ok(!ended && !startError, "Production server must remain running.");
  console.log("Smoke checks passed: dashboard, heartbeat, fresh structured health, security headers, and 404.");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await stopServer();
}
