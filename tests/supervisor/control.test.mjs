// Unit tests for tools/supervisor/lib/control.mjs — the version-independent
// /__supervisor HTTP control surface. handleControl is driven through a
// real local HTTP server (same technique the rest of this suite uses for
// fake upstreams) so cookies/headers/status codes are exercised for real,
// not simulated. Mutation endpoints that reach "ready" (build/pin-resume)
// use the fake-npx trick from _server-helpers.mjs.
//   node --test tests/supervisor/control.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { promises as fsp } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";
import { installFakeNpx } from "./_server-helpers.mjs";

process.env.BOS_HEALTH_TIMEOUT_MS = "5000";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// reconcile-client.mjs's postJson/getJson always target the frozen
// BASE_PORT config constant (not whatever state.base.port happens to be at
// call time) — reserve it BEFORE any tools/supervisor module is imported so
// the /promote test below can bind its fake base API to this exact port.
const reservedBasePort = await freePort();
process.env.BOS_PORT_BASE = String(reservedBasePort);

const env = makeSupervisorEnv("control-test-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const {
  handleControl,
  pinnedVersion,
  proxyTo,
  forwardUpgrade,
  proxyServiceHttp,
  proxyServiceUpgrade,
} = await import("../../tools/supervisor/lib/control.mjs");
const { state, previews } = await import("../../tools/supervisor/lib/state.mjs");
const { stopProc } = await import("../../tools/supervisor/lib/proc.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const sub = url.pathname === "/" ? "" : url.pathname.slice(1);
  void handleControl(req, res, sub);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function post(path, body, extraHeaders = {}) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}
async function get(path, extraHeaders = {}) {
  const res = await fetch(`${base}${path}`, { headers: extraHeaders });
  return { status: res.status, headers: res.headers, body: await res.text() };
}
async function getJson(path, extraHeaders = {}) {
  const res = await fetch(`${base}${path}`, { headers: extraHeaders });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function cleanupPreview(branch) {
  const p = previews.get(branch);
  if (p) await stopProc(p);
  previews.delete(branch);
}

test("GET / returns the control page HTML", async () => {
  const { status, headers, body } = await get("/");
  assert.equal(status, 200);
  assert.match(headers.get("content-type"), /text\/html/);
  assert.match(body, /BrowserOS Supervisor/);
});

test("GET /branches lists real git branches including base", async () => {
  git(env.repo, ["branch", "bos/testfixture-ctl-branch-a"]);
  const { status, json } = await getJson("/branches");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(json.branches.includes(env.baseBranch));
  assert.ok(json.branches.includes("bos/testfixture-ctl-branch-a"));
  git(env.repo, ["branch", "-D", "bos/testfixture-ctl-branch-a"]);
});

test("GET /preview-changes and /next-changes: no branch/preview -> candidate:null", async () => {
  const a = await getJson("/preview-changes");
  assert.deepEqual(a.json, { ok: true, candidate: null });
  const b = await getJson("/next-changes?branch=bos/testfixture-never-existed");
  assert.deepEqual(b.json, { ok: true, candidate: null });
});

test("GET /promote-status: unknown job -> 404; missing jobId -> 404", async () => {
  const missing = await getJson("/promote-status");
  assert.equal(missing.status, 404);
  const unknown = await getJson("/promote-status?jobId=never-existed");
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /unknown or expired/);
});

test("GET /health reflects state.base presence, procAlive, and supervision counters", async () => {
  state.base = null;
  const noBase = await getJson("/health");
  assert.equal(noBase.json.base, null);
  assert.equal(noBase.json.serving, false);

  state.base = { role: "base", state: "ready", port: 1, branch: "claude", commit: "abc123", reused: false, proc: { exitCode: null, signalCode: null, pid: 999 } };
  const withBase = await getJson("/health");
  assert.equal(withBase.json.base.procAlive, true);
  assert.equal(withBase.json.base.owned, true);
  assert.equal(withBase.json.base.pid, 999);
  assert.equal(withBase.json.serving, false, "port 1 refuses connections — not actually serving");
  state.base = null;
});

test("GET /state includes base/previews and the caller's pinned serving version", async () => {
  const { status, json } = await getJson("/state");
  assert.equal(status, 200);
  assert.equal(json.base, null);
  assert.deepEqual(json.previews, []);
  assert.equal(json.baseBranch, env.baseBranch);
  assert.equal(json.serving, null);
});

test("POST /logs (ingest) then GET /logs returns the ingested record; ?sessions=1 lists sessions", async () => {
  const ingest = await post("/logs", { records: [{ level: "info", msg: "hello from a test", sessionId: "sess-ctl-1" }] }, { "x-bos-session": "sess-ctl-1" });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.json.ok, true);
  assert.equal(ingest.json.n, 1);

  const read = await getJson("/logs?session=sess-ctl-1");
  assert.equal(read.status, 200);
  assert.ok(read.json.records.some((r) => r.msg === "hello from a test"));

  const sessions = await getJson("/logs?sessions=1");
  assert.ok(sessions.json.sessions.some((s) => s.id === "sess-ctl-1"));
});

test("unknown control endpoint returns 404", async () => {
  const { status, json } = await getJson("/this-is-not-a-real-endpoint");
  assert.equal(status, 404);
  assert.match(json.error, /unknown control endpoint/);
});

test("POST /pin: base clears the pin cookie; a branch that isn't ready is rejected with 400", async () => {
  const toBase = await post("/pin", { version: "base" });
  assert.equal(toBase.status, 200);
  assert.equal(toBase.json.pinned, "base");
  assert.match(toBase.headers.get("set-cookie"), /bos_pin=;/);

  const noBranch = await post("/pin", { version: "preview" });
  assert.equal(noBranch.status, 400);

  const notReady = await post("/pin", { version: "preview", branch: "bos/testfixture-never-provisioned" });
  assert.equal(notReady.status, 400);
  assert.match(notReady.json.error, /not ready/);
});

test("POST /pin: an invalid branch format is a 500 (thrown validation surfaces as a server error, not a 400)", async () => {
  const { status, json } = await post("/pin", { version: "preview", branch: "not-a-feature-branch" });
  assert.equal(status, 500);
  assert.match(json.error, /must match bos\/<kebab-name>/);
});

test("POST /begin: missing branch -> 400; success provisions and returns worktree/dataDir", async () => {
  const missing = await post("/begin", {});
  assert.equal(missing.status, 400);

  const branch = "bos/testfixture-ctl-begin";
  const { status, json } = await post("/begin", { branch });
  try {
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.branch, branch);
    assert.ok(json.worktree);
    assert.ok(json.dataDir);
  } finally {
    await cleanupPreview(branch);
  }
});

test("POST /build + GET /state serving + POST /pin: a built branch can be pinned and is reflected in /state's serving field", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/testfixture-ctl-build-pin";
    const built = await post("/build", { branch });
    assert.equal(built.status, 200);
    assert.equal(built.json.ok, true);
    assert.equal(built.json.state, "ready");

    const pin = await post("/pin", { version: "preview", branch });
    assert.equal(pin.status, 200);
    const cookieMatch = /bos_pin=([^;]+)/.exec(pin.headers.get("set-cookie"));
    assert.ok(cookieMatch);

    const st = await getJson("/state", { Cookie: `bos_pin=${cookieMatch[1]}` });
    assert.equal(st.json.serving.branch, branch);

    await cleanupPreview(branch);
  } finally {
    restore();
  }
});

test("POST /build: missing branch -> 400", async () => {
  const { status } = await post("/build", {});
  assert.equal(status, 400);
});

test("POST /pin: a STOPPED preview resumes and pins in one call", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/testfixture-ctl-pin-resume";
    await post("/build", { branch });
    await post("/stop", { branch });
    // stopPreview runs in the background (control.mjs sends the response
    // immediately) — poll until it actually lands.
    for (let i = 0; i < 50 && previews.get(branch)?.state !== "stopped"; i++) await new Promise((r) => setTimeout(r, 100));

    const pin = await post("/pin", { version: "preview", branch });
    assert.equal(pin.status, 200);
    assert.equal(previews.get(branch).state, "ready");
    await cleanupPreview(branch);
  } finally {
    restore();
  }
});

test("POST /activate: activating base clears the pin cookie", async () => {
  const { status, headers, json } = await post("/activate", { branch: "" });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.match(headers.get("set-cookie"), /bos_pin=;/);
});

test("POST /promote: missing branch -> 400; success returns a jobId immediately, pollable via /promote-status", async () => {
  const missing = await post("/promote", {});
  assert.equal(missing.status, 400);

  // A fake base API that answers pushNow/gitfs-reconcile so a full,
  // real "reused"-mode promote can complete quickly.
  const fakeBaseApi = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/gitfs/reconcile") {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method === "POST") return res.end(JSON.stringify({ jobId: "ctl-job" }));
      return res.end(JSON.stringify({ phase: "done", outcome: { status: "success", method: "ff" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  // Must bind to the reserved BASE_PORT — reconcile-client.mjs's
  // postJson/getJson always target that frozen config constant, regardless
  // of what state.base.port is set to below.
  await new Promise((resolve) => fakeBaseApi.listen(reservedBasePort, "127.0.0.1", resolve));
  const branch = "bos/testfixture-ctl-promote";
  git(env.repo, ["branch", branch]);
  const { addWorktreeForBranch, provisionClone } = await import("../../tools/supervisor/lib/worktree.mjs");
  const { ensureAppsRepo, mountCoupled } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
  const wt = await addWorktreeForBranch(branch);
  writeFileSync(join(wt, "feature.txt"), "a feature\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "feature"]);
  const dataDir = join(env.clones, branch);
  await provisionClone(dataDir);
  await ensureAppsRepo();
  await mountCoupled({ id: "user-apps", root: join(env.dataDir, "user-apps"), kind: "user-apps" }, join(dataDir, "user-apps"), branch);
  const commit = git(wt, ["rev-parse", "HEAD"]);
  previews.set(branch, { role: "preview", branch, worktree: wt, dataDir, port: 0, state: "ready", proc: null, commit });
  state.base = { role: "base", branch: state.baseBranch, reused: true, port: fakeBaseApi.address().port, state: "ready", proc: null, commit: git(env.repo, ["rev-parse", "HEAD"]) };
  try {
    const started = await post("/promote", { branch });
    assert.equal(started.status, 200);
    assert.equal(started.json.ok, true);
    assert.ok(started.json.jobId);

    let job;
    for (let i = 0; i < 100; i++) {
      job = await getJson(`/promote-status?jobId=${started.json.jobId}`);
      if (job.json.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(job.json.status, "done");
    assert.match(job.json.tag, /^bos\/v/);
  } finally {
    state.base = null;
    previews.delete(branch);
    await new Promise((resolve) => fakeBaseApi.close(resolve));
  }
});

test("POST /stop: missing branch -> 400; clears the pin cookie immediately even though the stop itself runs in the background", async () => {
  const missing = await post("/stop", {});
  assert.equal(missing.status, 400);

  const { status, headers } = await post("/stop", { branch: "bos/testfixture-never-provisioned" });
  assert.equal(status, 200);
  assert.match(headers.get("set-cookie"), /bos_pin=;/);
});

test("POST /discard: missing branch -> 400; a clean discard returns ok:true and clears the pin cookie", async () => {
  const missing = await post("/discard", {});
  assert.equal(missing.status, 400);

  const branch = "bos/testfixture-ctl-discard";
  await post("/begin", { branch });
  const { status, headers, json } = await post("/discard", { branch });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.match(headers.get("set-cookie"), /bos_pin=;/);
  previews.delete(branch);
});

test("POST /push: delegates to pushNow via base's own API", async () => {
  const fakeBaseApi = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => fakeBaseApi.listen(0, "127.0.0.1", resolve));
  state.base = { role: "base", state: "ready", port: fakeBaseApi.address().port };
  try {
    const { status, json } = await post("/push", {});
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.pushed, state.baseBranch);
  } finally {
    state.base = null;
    await new Promise((resolve) => fakeBaseApi.close(resolve));
  }
});

test("pinnedVersion: falls back to base when the pin cookie names a not-ready/absent preview", () => {
  const fakeReq = (cookie) => ({ headers: { cookie } });
  state.base = { role: "base", port: 1 };
  assert.equal(pinnedVersion(fakeReq("")), state.base);
  assert.equal(pinnedVersion(fakeReq("bos_pin=base")), state.base);
  assert.equal(pinnedVersion(fakeReq("bos_pin=bos%2Ftestfixture-absent")), state.base);
  previews.set("bos/testfixture-pin-target", { state: "building" });
  assert.equal(pinnedVersion(fakeReq("bos_pin=bos%2Ftestfixture-pin-target")), state.base, "not ready yet -> falls back to base");
  previews.get("bos/testfixture-pin-target").state = "ready";
  assert.equal(pinnedVersion(fakeReq("bos_pin=bos%2Ftestfixture-pin-target")), previews.get("bos/testfixture-pin-target"));
  previews.delete("bos/testfixture-pin-target");
  state.base = null;
});

test("proxyTo: proxies a real upstream response, and returns a friendly 502 page when the upstream is unreachable", async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200, { "X-From": "upstream" }); res.end("upstream body"); });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const front = http.createServer((req, res) => proxyTo(upstream.address().port, req, res));
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${front.address().port}/anything`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-from"), "upstream");
    assert.equal(await res.text(), "upstream body");
  } finally {
    await new Promise((resolve) => front.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }

  const front2 = http.createServer((req, res) => proxyTo(1, req, res));
  await new Promise((resolve) => front2.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${front2.address().port}/x`);
    assert.equal(res.status, 502);
    const body = await res.text();
    assert.match(body, /isn't responding/);
  } finally {
    await new Promise((resolve) => front2.close(resolve));
  }
});

test("proxyServiceHttp: no runtime.json / malformed port -> 502; a valid port proxies through", async () => {
  const dataDir = join(env.dataDir);
  state.base = { role: "base", state: "ready", port: 1, dataDir };
  try {
    const front = http.createServer((req, res) => { void proxyServiceHttp("svc-a", "/x", req, res); });
    await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
    try {
      const missing = await fetch(`http://127.0.0.1:${front.address().port}/x`);
      assert.equal(missing.status, 502);
    } finally {
      await new Promise((resolve) => front.close(resolve));
    }

    const cfgDir = join(dataDir, "system", "config", "svc-a");
    await fsp.mkdir(cfgDir, { recursive: true });
    await fsp.writeFile(join(cfgDir, "runtime.json"), JSON.stringify({ port: "not-a-number" }));
    const front2 = http.createServer((req, res) => { void proxyServiceHttp("svc-a", "/x", req, res); });
    await new Promise((resolve) => front2.listen(0, "127.0.0.1", resolve));
    try {
      const bad = await fetch(`http://127.0.0.1:${front2.address().port}/x`);
      assert.equal(bad.status, 502);
    } finally {
      await new Promise((resolve) => front2.close(resolve));
    }

    const upstream = http.createServer((req, res) => { res.writeHead(200); res.end("service body"); });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    await fsp.writeFile(join(cfgDir, "runtime.json"), JSON.stringify({ port: upstream.address().port }));
    const front3 = http.createServer((req, res) => { void proxyServiceHttp("svc-a", "/x", req, res); });
    await new Promise((resolve) => front3.listen(0, "127.0.0.1", resolve));
    try {
      const ok = await fetch(`http://127.0.0.1:${front3.address().port}/x`);
      assert.equal(ok.status, 200);
      assert.equal(await ok.text(), "service body");
    } finally {
      await new Promise((resolve) => front3.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    }
  } finally {
    state.base = null;
  }
});

test("forwardUpgrade: relays a WebSocket-style upgrade handshake end to end", async () => {
  const upstreamPort = await freePort();
  const upstream = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.write("hello-from-upstream");
    });
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  const frontServer = http.createServer();
  frontServer.on("upgrade", (req, clientSocket, head) => forwardUpgrade(upstreamPort, req, clientSocket, head));
  await new Promise((resolve) => frontServer.listen(0, "127.0.0.1", resolve));
  try {
    const client = net.createConnection(frontServer.address().port, "127.0.0.1");
    const received = await new Promise((resolve, reject) => {
      client.on("connect", () => {
        client.write("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      });
      let buf = "";
      client.on("data", (c) => { buf += c.toString(); if (buf.includes("hello-from-upstream")) resolve(buf); });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timed out waiting for upgrade relay")), 4000);
    });
    assert.match(received, /101 Switching Protocols/);
    assert.match(received, /hello-from-upstream/);
    client.destroy();
  } finally {
    await new Promise((resolve) => frontServer.close(resolve));
    upstream.close();
  }
});

test("proxyServiceUpgrade: no resolvable service port destroys the client socket instead of hanging", async () => {
  state.base = { role: "base", state: "ready", port: 1, dataDir: env.dataDir };
  try {
    let destroyed = false;
    const clientSocket = { destroy: () => { destroyed = true; } };
    await proxyServiceUpgrade("svc-never-configured", { url: "/x", headers: {} }, clientSocket, Buffer.alloc(0));
    assert.equal(destroyed, true);
  } finally {
    state.base = null;
  }
});

test.after(async () => {
  env.cleanup();
  await new Promise((resolve) => server.close(resolve));
});
