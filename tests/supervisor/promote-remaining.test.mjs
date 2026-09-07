// Unit tests for the remaining branches of tools/supervisor/lib/promote.mjs
// not already covered by promote-safety.test.mjs (which only exercises
// "reused" mode's happy path and the pre-code-promote coupled-repo abort):
// dirty-checkout / package-lock-drift pre-flight, a not-yet-built candidate
// being built automatically, "dev" and "prod" mode deployToBase (restart/
// rebuild), and a rebuild failure leaving base down. isFastForwardable's own
// guard is a genuine TOCTOU race (base moving DURING the promote's own
// build/health-gate) with no seam to trigger deterministically from outside
// and is not covered here.
// Same scaffolding as promote-safety.test.mjs: a fake HTTP server stands in
// for base's /api/gitfs/reconcile, and the fake-npx trick lets
// build/restart reach a real "ready" state.
//   node --test tests/supervisor/promote-remaining.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";
import { installFakeNpx, writeFakeServerScript } from "./_server-helpers.mjs";

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

const reservedBasePort = await freePort();
process.env.BOS_PORT_BASE = String(reservedBasePort);

let reconcileHandler = () => ({ status: 200, json: { phase: "done", outcome: { status: "success", method: "ff" } } });
const fakeBase = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/gitfs/reconcile") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "POST") return res.end(JSON.stringify({ jobId: "job" }));
    const { status, json } = reconcileHandler();
    if (status !== 200) { res.writeHead(status); return res.end(JSON.stringify(json)); }
    return res.end(JSON.stringify(json));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => fakeBase.listen(reservedBasePort, "127.0.0.1", resolve));

const env = makeSupervisorEnv("promote-remaining-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const { addWorktreeForBranch, provisionClone } = await import("../../tools/supervisor/lib/worktree.mjs");
const { mountCoupled, ensureAppsRepo } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
const { promote } = await import("../../tools/supervisor/lib/promote.mjs");
const { state, previews } = await import("../../tools/supervisor/lib/state.mjs");
const { stopProc } = await import("../../tools/supervisor/lib/proc.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

async function makeCandidate(branch, { editFile = `${branch.replace(/\//g, "-")}.txt`, editContent = `a feature for ${branch}\n` } = {}) {
  git(env.repo, ["branch", branch]);
  const worktree = await addWorktreeForBranch(branch);
  writeFileSync(join(worktree, editFile), editContent);
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-q", "-m", `BOS candidate (${branch})`]);

  const dataDir = join(env.clones, branch);
  await provisionClone(dataDir);
  await ensureAppsRepo();
  const userAppsDst = join(dataDir, "user-apps");
  await mountCoupled({ id: "user-apps", root: join(env.dataDir, "user-apps"), kind: "user-apps" }, userAppsDst, branch);

  const commit = git(worktree, ["rev-parse", "HEAD"]);
  const cand = { role: "preview", branch, worktree, dataDir, port: 0, state: "ready", proc: null, commit };
  previews.set(branch, cand);
  return { worktree, dataDir, userAppsDst, commit };
}

// tagStamp() has SECOND precision — two promote() calls landing in the same
// wall-clock second would collide on the same tag name. A short gap between
// tests (this file calls promote() repeatedly, fast) keeps that from ever
// happening here; it is not something these tests need to work around via
// mocking, just via not colliding in real wall-clock time.
test.beforeEach(async () => {
  reconcileHandler = () => ({ status: 200, json: { phase: "done", outcome: { status: "success", method: "ff" } } });
  await new Promise((r) => setTimeout(r, 1100));
});

test("promote: a dirty base checkout (beyond package-lock.json) aborts before anything else", async () => {
  const branch = "bos/promote-dirty";
  await makeCandidate(branch);
  const commit = git(env.repo, ["rev-parse", "HEAD"]);
  state.base = { role: "base", branch: state.baseBranch, reused: true, port: reservedBasePort, state: "ready", proc: null, commit };
  writeFileSync(join(env.repo, "unstaged-drift.txt"), "someone edited REPO directly\n");
  try {
    await assert.rejects(promote(branch), /uncommitted changes/);
  } finally {
    git(env.repo, ["clean", "-fd"]);
    previews.delete(branch);
    state.base = null;
  }
});

test("promote: package-lock.json-only drift in base is discarded automatically, not treated as blocking dirt", async () => {
  const branch = "bos/promote-lockfile-drift";
  const { commit } = await makeCandidate(branch);
  const baseCommit = git(env.repo, ["rev-parse", "HEAD"]);
  state.base = { role: "base", branch: state.baseBranch, reused: true, port: reservedBasePort, state: "ready", proc: null, commit: baseCommit };
  writeFileSync(join(env.repo, "package-lock.json"), '{"drift": true}');
  try {
    const result = await promote(branch);
    assert.equal(result.tag && true, true, "promote must have succeeded despite the lockfile drift");
    assert.equal(git(env.repo, ["rev-parse", state.baseBranch]), commit);
  } finally {
    previews.delete(branch);
    state.base = null;
  }
});

test("promote: a stopped/not-built candidate is built automatically before promoting", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/promote-autobuild";
    git(env.repo, ["branch", branch]);
    const worktree = await addWorktreeForBranch(branch);
    writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "fake-bos", scripts: { build: 'node -e "process.exit(0)"' } }));
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-q", "-m", "buildable"]);
    const dataDir = join(env.clones, branch);
    await provisionClone(dataDir);
    await ensureAppsRepo();
    await mountCoupled({ id: "user-apps", root: join(env.dataDir, "user-apps"), kind: "user-apps" }, join(dataDir, "user-apps"), branch);
    const cand = { role: "preview", branch, worktree, dataDir, port: await freePort(), state: "not-built", proc: null, commit: git(worktree, ["rev-parse", "HEAD"]) };
    previews.set(branch, cand);
    state.base = { role: "base", branch: state.baseBranch, reused: true, port: reservedBasePort, state: "ready", proc: null, commit: git(env.repo, ["rev-parse", "HEAD"]) };
    try {
      const result = await promote(branch);
      assert.ok(result.tag);
      assert.equal(previews.has(branch), false);
    } finally {
      state.base = null;
    }
  } finally {
    restore();
  }
});

test("promote: 'dev' mode restarts base via startBaseDevProc after merging", async () => {
  const devScriptDir = join(env.dataDir, "fake-dev-script");
  mkdirSync(devScriptDir, { recursive: true });
  const devScript = writeFakeServerScript(join(devScriptDir, "server.mjs"));
  const pkgPath = join(env.repo, "package.json");
  const original = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(original);
  pkg.scripts.dev = `node ${devScript}`;
  writeFileSync(pkgPath, JSON.stringify(pkg));
  git(env.repo, ["add", "-A"]);
  git(env.repo, ["commit", "-q", "-m", "add fake dev script"]);

  const branch = "bos/promote-dev-mode";
  const { commit } = await makeCandidate(branch);
  state.base = { role: "base", branch: state.baseBranch, dev: true, port: reservedBasePort, state: "ready", proc: null, commit: git(env.repo, ["rev-parse", "HEAD"]) };
  try {
    const result = await promote(branch);
    assert.equal(result.dev, true);
    assert.equal(git(env.repo, ["rev-parse", state.baseBranch]), commit);
    assert.equal(state.base.state, "ready");
  } finally {
    await stopProc(state.base);
    state.base = null;
    previews.delete(branch);
  }
});

test("promote: 'prod' mode rebuilds and restarts base via a real health-gated server", async () => {
  const { restore } = installFakeNpx();
  try {
    const pkgPath = join(env.repo, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ name: "fake-bos", scripts: { build: 'node -e "process.exit(0)"' } }));
    git(env.repo, ["add", "-A"]);
    git(env.repo, ["commit", "-q", "-m", "fast build script"]);

    const branch = "bos/promote-prod-mode";
    const { commit } = await makeCandidate(branch);
    const basePort = await freePort();
    state.base = { role: "base", branch: state.baseBranch, worktree: env.repo, dataDir: env.dataDir, port: basePort, state: "ready", proc: null, commit: git(env.repo, ["rev-parse", "HEAD"]) };
    try {
      const result = await promote(branch);
      assert.equal(result.dev, false);
      assert.equal(result.reused, false);
      assert.equal(git(env.repo, ["rev-parse", state.baseBranch]), commit);
      assert.equal(state.base.state, "ready");
    } finally {
      await stopProc(state.base);
      state.base = null;
      previews.delete(branch);
    }
  } finally {
    restore();
  }
});

test("promote: 'prod' mode — a rebuild failure leaves base DOWN and throws a clear, actionable error", async () => {
  const pkgPath = join(env.repo, "package.json");
  writeFileSync(pkgPath, JSON.stringify({ name: "fake-bos", scripts: { build: 'node -e "process.exit(1)"' } }));
  git(env.repo, ["add", "-A"]);
  git(env.repo, ["commit", "-q", "-m", "build always fails now"]);

  const branch = "bos/promote-prod-rebuild-fails";
  await makeCandidate(branch);
  const basePort = await freePort();
  state.base = { role: "base", branch: state.baseBranch, worktree: env.repo, dataDir: env.dataDir, port: basePort, state: "ready", proc: null, commit: git(env.repo, ["rev-parse", "HEAD"]) };
  try {
    await assert.rejects(promote(branch), /base rebuild failed after merging/);
    assert.equal(state.base.state, "failed");
  } finally {
    previews.delete(branch);
    state.base = null;
  }
});

test.after(async () => {
  env.cleanup();
  await new Promise((resolve) => fakeBase.close(resolve));
});
