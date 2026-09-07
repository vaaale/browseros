// Unit tests for tools/supervisor/lib/base.mjs — regenApps, building/starting
// base (both `next start`-style "prod" and Supervisor-owned `next dev`), and
// restartBase's backoff/give-up policy. Uses the fake-npx / fake-dev-script
// trick from _server-helpers.mjs so these reach a real "ready" state without
// an actual Next.js install, and BOS_HEALTH_TIMEOUT_MS is raised (matching
// proc.test.mjs's own reasoning) so the health-gate isn't racy against real
// process-spawn latency.
//   node --test tests/supervisor/base.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";
import { writeFakeServerScript, installFakeNpx } from "./_server-helpers.mjs";

process.env.BOS_HEALTH_TIMEOUT_MS = "5000";

const env = makeSupervisorEnv("base-test-");
const fakeDevScriptDir = mkdtempSync(join(tmpdir(), "base-test-fake-dev-"));
const fakeDevServerScript = writeFakeServerScript(join(fakeDevScriptDir, "fake-dev-server.mjs"));

const { regenApps, buildAndStartBase, buildAndStartBaseDev, restartBase } = await import("../../tools/supervisor/lib/base.mjs");
const { BASE_PORT, BASE_RESTART_MAX } = await import("../../tools/supervisor/lib/config.mjs");
const { state, baseSupervision } = await import("../../tools/supervisor/lib/state.mjs");
const { stopProc } = await import("../../tools/supervisor/lib/proc.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
state.baseBranch = env.baseBranch;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function resetSupervision() {
  baseSupervision.restarts = 0;
  baseSupervision.consecutiveFailures = 0;
  baseSupervision.lastExit = null;
  baseSupervision.lastRestartAt = null;
  baseSupervision.givenUp = false;
  state.baseRestarting = false;
  state.shuttingDown = false;
}

async function teardownBase() {
  if (state.base) await stopProc(state.base);
  state.base = null;
  resetSupervision();
}

function setDevScript() {
  const pkgPath = join(env.repo, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts.dev = `node ${fakeDevServerScript}`;
  writeFileSync(pkgPath, JSON.stringify(pkg));
}
setDevScript();
git(env.repo, ["add", "-A"]);
git(env.repo, ["commit", "-q", "-m", "add fake dev script"]);

test("regenApps: success runs cleanly with no warnings", async () => {
  mkdirSync(join(env.repo, "tools"), { recursive: true });
  writeFileSync(join(env.repo, "tools", "gen-apps.mjs"), "process.exit(0);\n");
  const warnings = [];
  await regenApps(warnings);
  assert.deepEqual(warnings, []);
});

test("regenApps: a failing script records a warning instead of throwing", async () => {
  mkdirSync(join(env.repo, "tools"), { recursive: true });
  writeFileSync(join(env.repo, "tools", "gen-apps.mjs"), "process.exit(1);\n");
  const warnings = [];
  await assert.doesNotReject(regenApps(warnings));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gen-apps failed/);
});

test("buildAndStartBase: a successful build starts a healthy prod-mode base", async () => {
  const { restore } = installFakeNpx();
  try {
    const commit = git(env.repo, ["rev-parse", "HEAD"]);
    const result = await buildAndStartBase(commit);
    assert.equal(result, "ready");
    assert.equal(state.base.state, "ready");
    assert.equal(state.base.port, BASE_PORT);
  } finally {
    await teardownBase();
    restore();
  }
});

test("buildAndStartBase: a failing build throws and leaves state.base 'failed'", async () => {
  const pkgPath = join(env.repo, "package.json");
  const original = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(original);
  pkg.scripts.build = 'node -e "process.exit(1)"';
  writeFileSync(pkgPath, JSON.stringify(pkg));
  try {
    const commit = git(env.repo, ["rev-parse", "HEAD"]);
    await assert.rejects(buildAndStartBase(commit), /base build failed/);
    assert.equal(state.base.state, "failed");
    assert.ok(state.base.buildError);
  } finally {
    writeFileSync(pkgPath, original);
    await teardownBase();
  }
});

test("startBaseDevProc / buildAndStartBaseDev: starts a healthy Supervisor-owned dev server", async () => {
  const result = await buildAndStartBaseDev();
  try {
    assert.equal(result, "ready");
    assert.equal(state.base.state, "ready");
    assert.equal(state.base.dev, true);
    assert.equal(state.base.port, BASE_PORT);
  } finally {
    await teardownBase();
  }
});

test("buildAndStartBaseDev: an unhealthy dev server throws", async () => {
  process.env.FAKE_SERVER_UNHEALTHY = "1";
  try {
    await assert.rejects(buildAndStartBaseDev(), /failed to become healthy/);
  } finally {
    delete process.env.FAKE_SERVER_UNHEALTHY;
    await teardownBase();
  }
});

test("restartBase: a reused (external) base is left alone — the Supervisor never touches someone else's process", async () => {
  state.base = { role: "base", reused: true, state: "ready", port: 1 };
  try {
    await restartBase("stopped responding");
    assert.equal(baseSupervision.restarts, 0);
    assert.equal(state.base.state, "ready", "must be untouched");
  } finally {
    await teardownBase();
  }
});

test("restartBase: no base at all is a silent no-op", async () => {
  state.base = null;
  await restartBase("whatever");
  assert.equal(baseSupervision.restarts, 0);
});

test("restartBase: already shutting down short-circuits without attempting anything", async () => {
  state.base = { role: "base", state: "failed", port: 1 };
  state.shuttingDown = true;
  try {
    await restartBase("dying");
    assert.equal(baseSupervision.restarts, 0);
  } finally {
    await teardownBase();
  }
});

test("restartBase: recovers a crashed prod-mode base back to healthy, resetting consecutiveFailures", async () => {
  const { restore } = installFakeNpx();
  try {
    const port = await freePort();
    state.base = { role: "base", branch: env.baseBranch, worktree: env.repo, dataDir: env.dataDir, port, state: "failed", proc: null, commit: git(env.repo, ["rev-parse", "HEAD"]) };
    baseSupervision.consecutiveFailures = 1; // simulates one prior failed attempt

    // restartBase always builds base at BASE_PORT internally (waitHealthy is
    // called against BASE_PORT, not state.base.port) — align them so the
    // health-gate checks the port our fake server actually binds via startProc.
    state.base.port = BASE_PORT;
    await restartBase("crashed");

    assert.equal(state.base.state, "ready");
    assert.equal(baseSupervision.consecutiveFailures, 0);
    assert.equal(baseSupervision.restarts, 1);
  } finally {
    await teardownBase();
    restore();
  }
});

test("restartBase: recovers a crashed DEV-mode base via startBaseDevProc", async () => {
  state.base = { role: "base", branch: env.baseBranch, worktree: env.repo, dataDir: env.dataDir, port: BASE_PORT, state: "failed", proc: null, dev: true, commit: git(env.repo, ["rev-parse", "HEAD"]) };
  try {
    await restartBase("crashed");
    assert.equal(state.base.state, "ready");
    assert.equal(baseSupervision.consecutiveFailures, 0);
  } finally {
    await teardownBase();
  }
});

test("restartBase: gives up after BASE_RESTART_MAX consecutive failures, without attempting another restart", async () => {
  state.base = { role: "base", branch: env.baseBranch, port: BASE_PORT, state: "failed", proc: null };
  baseSupervision.consecutiveFailures = BASE_RESTART_MAX;
  try {
    const start = Date.now();
    await restartBase("still dying");
    assert.ok(Date.now() - start < 500, "must give up immediately, before any backoff wait");
    assert.equal(baseSupervision.givenUp, true);
    assert.equal(state.base.state, "failed");
    assert.match(state.base.buildError, /gave up after/);
  } finally {
    await teardownBase();
  }
});

test.after(() => {
  env.cleanup();
  rmSync(fakeDevScriptDir, { recursive: true, force: true });
});
