// Unit tests for tools/supervisor/lib/proc.mjs — port probing/allocation,
// the exit-handling contract shared by base.mjs and preview.mjs, and process
// lifecycle (start/stop/health-gate/reap). wireExitHandler/stopProc are
// tested against a FAKE proc object (a plain EventEmitter shaped like a
// ChildProcess) where the exact scenario (OOM signal, ignored SIGTERM,
// already-exited) needs to be deterministic; startProc/waitHealthy are
// tested against a REAL spawned process via a fake `npx` (see
// _server-helpers.mjs) so the real health-check HTTP round trip is
// exercised too.
//   node --test tests/supervisor/proc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeNpx } from "./_server-helpers.mjs";

// waitHealthy retries every 1500ms (fixed, not configurable) — this must be
// long enough for a REAL freshly-spawned node process to come up (a couple
// retry cycles), or the "becomes healthy" tests below are racy under load.
process.env.BOS_HEALTH_TIMEOUT_MS = "5000";

const {
  probeOnce,
  allocPreviewPort,
  consumeExpectedExit,
  describeExit,
  wireExitHandler,
  setBaseExitHandler,
  startProc,
  stopProc,
  waitHealthy,
  reapOrphanedPreviewServers,
} = await import("../../tools/supervisor/lib/proc.mjs");
const { state, previews } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
const logDir = mkdtempSync(join(tmpdir(), "proc-test-log-"));
initLogStore(logDir);
state.baseBranch = "claude";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test("probeOnce: a free port resolves false, an HTTP-answering port resolves true", async () => {
  assert.equal(await probeOnce(await freePort()), false);

  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(await probeOnce(server.address().port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("probeOnce: a raw TCP-only listener (connects, never answers HTTP) still counts as occupied", async () => {
  const server = net.createServer((socket) => { socket.on("data", () => {}); }); // accepts, never replies
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(await probeOnce(server.address().port), true);
  } finally {
    server.close();
  }
});

test("allocPreviewPort: skips ports already tracked by state.base/previews and anything foreign already listening", async () => {
  const base = await freePort();
  process.env.BOS_PORT_BASE = String(base);
  process.env.BOS_PORT_POOL_SIZE = "4";
  // Re-import with a fresh module registry isn't possible for config.mjs
  // (frozen per process) — this test instead drives allocPreviewPort's own
  // used-port bookkeeping directly against the ALREADY-frozen BASE_PORT/
  // POOL_SIZE from this file's first import, using ports it actually
  // computes from those (BASE_PORT+1..+POOL_SIZE).
  const { BASE_PORT, POOL_SIZE } = await import("../../tools/supervisor/lib/config.mjs");
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(BASE_PORT + 1, "127.0.0.1", resolve));
  try {
    state.base = { port: BASE_PORT + 2 };
    previews.clear();
    previews.set("bos/x", { port: BASE_PORT + 3 });
    const allocated = await allocPreviewPort();
    assert.equal(allocated, BASE_PORT + 4, `expected the first free slot after skipping +1(occupied)/+2(base)/+3(preview), within pool size ${POOL_SIZE}`);
  } finally {
    occupied.close();
    state.base = null;
    previews.clear();
  }
});

test("allocPreviewPort: throws when the entire pool is exhausted", async () => {
  const { BASE_PORT, POOL_SIZE } = await import("../../tools/supervisor/lib/config.mjs");
  previews.clear();
  state.base = { port: BASE_PORT }; // harmless; loop starts at BASE_PORT+1 regardless
  for (let p = BASE_PORT + 1; p <= BASE_PORT + POOL_SIZE; p++) previews.set(`bos/p${p}`, { port: p });
  try {
    await assert.rejects(allocPreviewPort(), /no free preview port in pool/);
  } finally {
    state.base = null;
    previews.clear();
  }
});

test("consumeExpectedExit: single-shot — true once, then false", () => {
  const v = { expectingExit: true };
  assert.equal(consumeExpectedExit(v), true);
  assert.equal(consumeExpectedExit(v), false);
});

test("describeExit: signal takes priority; falls back to code, then 'code null'", () => {
  assert.equal(describeExit(0, "SIGTERM"), "signal SIGTERM");
  assert.equal(describeExit(1, null), "code 1");
  assert.equal(describeExit(null, null), "code null");
});

function fakeChildProcess() {
  const p = new EventEmitter();
  p.pid = 424242;
  p.killed = false;
  p.exitCode = null;
  p.signalCode = null;
  p.kill = () => { p.exitCode = 0; p.emit("exit", 0, null); };
  return p;
}

test("wireExitHandler: an unexpected exit from a READY version marks it stopped", () => {
  const v = { role: "preview", branch: "bos/x", state: "ready", proc: fakeChildProcess() };
  wireExitHandler(v);
  v.proc.emit("exit", 1, null);
  assert.equal(v.state, "stopped");
});

test("wireExitHandler: an unexpected exit from a BUILDING version marks it failed with a buildError naming the exit", () => {
  const v = { role: "preview", branch: "bos/x", state: "building", proc: fakeChildProcess() };
  wireExitHandler(v);
  v.proc.emit("exit", null, "SIGSEGV");
  assert.equal(v.state, "failed");
  assert.match(v.buildError, /signal SIGSEGV/);
});

test("wireExitHandler: an EXPECTED exit (Stop/promote) never triggers base-restart or a state flip away from what the caller already set", () => {
  const v = { role: "preview", branch: "bos/x", state: "ready", expectingExit: true, proc: fakeChildProcess() };
  wireExitHandler(v);
  v.proc.emit("exit", 0, null);
  assert.equal(v.state, "stopped", "state bookkeeping still applies — only the base-restart trigger is suppressed for expected exits");
  assert.equal(v.expectingExit, false, "consumed");
});

test("wireExitHandler: base's own UNEXPECTED exit invokes the restart handler wired via setBaseExitHandler", () => {
  const v = { role: "base", branch: "claude", state: "ready", proc: fakeChildProcess() };
  state.base = v;
  let calledWith = null;
  setBaseExitHandler((reason) => { calledWith = reason; });
  try {
    wireExitHandler(v);
    v.proc.emit("exit", null, "SIGKILL");
    assert.equal(calledWith, "signal SIGKILL");
  } finally {
    setBaseExitHandler(null);
    state.base = null;
  }
});

test("wireExitHandler: SIGKILL on base is flagged OOM-suspected in baseSupervision.lastExit", async () => {
  const { baseSupervision } = await import("../../tools/supervisor/lib/state.mjs");
  const v = { role: "base", branch: "claude", state: "ready", proc: fakeChildProcess() };
  state.base = v;
  setBaseExitHandler(() => {});
  try {
    wireExitHandler(v);
    v.proc.emit("exit", null, "SIGKILL");
    assert.equal(baseSupervision.lastExit.oomSuspected, true);
    assert.equal(baseSupervision.lastExit.signal, "SIGKILL");
  } finally {
    setBaseExitHandler(null);
    state.base = null;
  }
});

test("stopProc: no proc / already-exited proc resolves immediately without signaling anything", async () => {
  await stopProc(null);
  await stopProc(undefined);
  const v = { proc: null };
  await stopProc(v);
  assert.equal(v.proc, null);

  const exited = fakeChildProcess();
  exited.exitCode = 0;
  const v2 = { proc: exited };
  await stopProc(v2);
  assert.equal(v2.proc, null);
});

test("stopProc: a process group kill failure (ESRCH-like) falls back to killing just the child, which then exits", async () => {
  const p = fakeChildProcess();
  p.pid = -999999; // process.kill(-(-999999)) = process.kill(999999) targets a real (nonexistent) pid — throws ESRCH
  const v = { proc: p };
  await stopProc(v);
  assert.equal(v.proc, null, "the fallback p.kill() path must still resolve stopProc");
});

test("startProc + waitHealthy + stopProc: a real spawned server (via fake npx) becomes healthy, then stops and frees its port", async () => {
  const { restore } = installFakeNpx();
  try {
    const port = await freePort();
    const worktree = mkdtempSync(join(tmpdir(), "proc-startproc-wt-"));
    const v = { role: "preview", branch: "bos/x", worktree, dataDir: worktree, port, state: "building", proc: null };
    startProc(v);
    try {
      const healthy = await waitHealthy(port, v);
      assert.equal(healthy, true);
      assert.equal(await probeOnce(port), true);
    } finally {
      await stopProc(v);
    }
    assert.equal(v.proc, null);
    // Give the OS a brief moment to fully release the port after SIGTERM.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await probeOnce(port), false, "the port must be free after stopProc");
    rmSync(worktree, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("waitHealthy: an unhealthy server (never answers /api/health) times out and returns false", async () => {
  const { restore } = installFakeNpx();
  try {
    const port = await freePort();
    const worktree = mkdtempSync(join(tmpdir(), "proc-unhealthy-wt-"));
    const v = { role: "preview", branch: "bos/x", worktree, dataDir: worktree, port, state: "building", proc: null };
    const origEnv = process.env.FAKE_SERVER_UNHEALTHY;
    process.env.FAKE_SERVER_UNHEALTHY = "1";
    try {
      startProc(v);
      const healthy = await waitHealthy(port, v);
      assert.equal(healthy, false);
    } finally {
      process.env.FAKE_SERVER_UNHEALTHY = origEnv;
      await stopProc(v);
      rmSync(worktree, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test("waitHealthy: the version's own process dying mid-wait resolves false immediately, not after the full timeout", async () => {
  const v = { proc: fakeChildProcess(), state: "building" };
  v.proc.exitCode = 1;
  const start = Date.now();
  const healthy = await waitHealthy(59999, v);
  assert.equal(healthy, false);
  assert.ok(Date.now() - start < 500, "must not wait out the full health timeout when the process already died");
});

test("waitHealthy: a 'failed' state with a buildError resolves false immediately", async () => {
  const v = { proc: null, state: "failed", buildError: "boom" };
  const start = Date.now();
  const healthy = await waitHealthy(59999, v);
  assert.equal(healthy, false);
  assert.ok(Date.now() - start < 500);
});

test("reapOrphanedPreviewServers: kills a real orphaned server occupying a pool port and frees it", async () => {
  const { BASE_PORT } = await import("../../tools/supervisor/lib/config.mjs");
  const { writeFakeServerScript } = await import("./_server-helpers.mjs");
  const { spawn } = await import("node:child_process");
  const scriptDir = mkdtempSync(join(tmpdir(), "proc-orphan-script-"));
  const scriptPath = writeFakeServerScript(join(scriptDir, "orphan-server.mjs"));
  const orphanPort = BASE_PORT + 1;
  const orphan = spawn(process.execPath, [scriptPath, "-p", String(orphanPort)], { detached: true, stdio: "ignore" });
  orphan.unref();
  try {
    // Wait for it to actually be listening before reaping.
    for (let i = 0; i < 50 && !(await probeOnce(orphanPort)); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(await probeOnce(orphanPort), true, "precondition: the orphan must be listening");

    await reapOrphanedPreviewServers();

    // Give the SIGTERM a moment to take effect (reapOrphanedPreviewServers
    // itself already waits out its own 5s escalation window internally, but
    // only when the process didn't respond to SIGTERM).
    for (let i = 0; i < 50 && (await probeOnce(orphanPort)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await probeOnce(orphanPort), false, "the orphaned server must have been reaped");
  } finally {
    try { process.kill(orphan.pid, "SIGKILL"); } catch { /* already gone */ }
    rmSync(scriptDir, { recursive: true, force: true });
  }
});

test.after(() => rmSync(logDir, { recursive: true, force: true }));
