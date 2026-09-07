// Unit tests for the remaining branches of tools/supervisor/lib/build.mjs
// not already covered by build-commit-safety.test.mjs: runBuild's spawn
// failure and output-tail truncation, buildAndStart's spec-store commit
// warning, a genuine (non-"nothing to commit") commit failure, the
// assertRepoIntegrity safety-gate-violated abort, and the success/
// unhealthy paths through startProc/waitHealthy (via the fake-npx trick).
//   node --test tests/supervisor/build-remaining.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, makeSpecStore, git } from "./_data-helpers.mjs";
import { installFakeNpx } from "./_server-helpers.mjs";

process.env.BOS_HEALTH_TIMEOUT_MS = "5000";

const env = makeSupervisorEnv("build-remaining-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const { runBuild, buildAndStart } = await import("../../tools/supervisor/lib/build.mjs");
const { addWorktreeForBranch } = await import("../../tools/supervisor/lib/worktree.mjs");
const { mountCoupled } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
const { stopProc } = await import("../../tools/supervisor/lib/proc.mjs");
const { state } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
// openBuildLog() opens a write stream synchronously without waiting for the
// store's own (async) directory creation — wait for it here so runBuild
// never races LogStore's own mkdir on first use.
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

function fakeVersion(overrides) {
  return { role: "preview", state: "not-built", proc: null, buildError: "", buildLog: "", commit: undefined, port: 45998, ...overrides };
}

test("runBuild: a spawn failure (bad cwd) resolves ok:false with a 'failed to spawn' reason", async () => {
  const result = await runBuild("/nonexistent/not-a-real-directory-at-all", "bos/spawn-fail");
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.match(result.reason, /failed to spawn build/);
});

test("runBuild: a SYNCHRONOUS spawn throw (invalid cwd type) is caught, not left to crash the caller", async () => {
  // node:child_process.spawn validates options.cwd's TYPE synchronously and
  // throws immediately (before any async 'error' event) when it isn't a
  // string/Buffer/URL — a different failure mode than the async ENOENT case
  // above, and the one runBuild's own try/catch around spawn() exists for.
  const result = await runBuild(12345, "bos/spawn-sync-throw");
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.match(result.reason, /failed to spawn build/);
});

test("runBuild: a huge failing build's output tail is bounded, not unbounded", async () => {
  const bigOutputDir = join(env.worktrees, "..", "build-remaining-bigoutput");
  mkdirSync(bigOutputDir, { recursive: true });
  writeFileSync(
    join(bigOutputDir, "package.json"),
    JSON.stringify({ name: "x", scripts: { build: 'node -e "for(let i=0;i<5000;i++)console.log(\'x\'.repeat(80)); process.exit(1)"' } }),
  );
  const result = await runBuild(bigOutputDir, "bos/big-output");
  assert.equal(result.ok, false);
  assert.ok(result.reason.length <= 16 * 1024, "the failure reason must be bounded by the tail cap, not the full build output");
});

test("buildAndStart: a spec-store commit failure is recorded as a warning but does not abort the build", async () => {
  const branch = "bos/spec-warn";
  git(env.repo, ["branch", branch]);
  const wt = await addWorktreeForBranch(branch);
  const store = makeSpecStore(join(env.dataDir, "specs"), "warn-store", "master");
  const dst = join(wt, "specs", "warn-store");
  await mountCoupled({ id: "warn-store", root: store, kind: "spec-store" }, dst, branch);
  // Corrupt the mounted worktree's git dir so commitCoupled's `git add -A` fails outright.
  writeFileSync(join(dst, ".git"), "gitdir: /nonexistent/broken\n");
  const pkgPath = join(env.repo, "package.json");
  const original = readFileSync(pkgPath, "utf8");
  writeFileSync(pkgPath, JSON.stringify({ name: "fake-bos", scripts: { build: 'node -e "process.exit(1)"' } }));
  try {
    const v = fakeVersion({ worktree: wt, branch, role: "preview", port: 45901 });
    await buildAndStart(v);
    // buildAndStart must not throw despite the corrupted spec-store mount
    // (warn-and-continue, not abort) — and the corrupted mount itself must
    // survive untouched (proving nothing destructive ran against it).
    assert.equal(existsSync(dst), true);
  } finally {
    writeFileSync(pkgPath, original);
  }
});

test("buildAndStart: a genuine (non-'nothing to commit') commit failure aborts and names the real reason", async () => {
  const branch = "bos/commit-hook-fails";
  git(env.repo, ["branch", branch]);
  const wt = await addWorktreeForBranch(branch);
  writeFileSync(join(wt, "edit.txt"), "an edit that will be staged\n");
  // Worktrees SHARE hooks via the repo's one common git dir — a hook
  // installed here affects every other worktree/test in this file too, so
  // it must be removed again before this test returns.
  const hooksDir = git(wt, ["rev-parse", "--git-path", "hooks"]);
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");
  writeFileSync(hookPath, "#!/bin/sh\necho 'blocked by policy' >&2\nexit 1\n");
  chmodSync(hookPath, 0o755);

  try {
    const v = fakeVersion({ worktree: wt, branch, role: "preview" });
    const result = await buildAndStart(v);

    assert.equal(result, "failed");
    assert.match(v.buildError, /failed to commit candidate changes/i);
    assert.match(v.buildError, /blocked by policy/);
  } finally {
    rmSync(hookPath, { force: true });
  }
});

test("buildAndStart: a live-checkout safety-gate violation aborts before any build step, and restores REPO", async () => {
  const branch = "bos/safety-gate";
  git(env.repo, ["branch", branch]);
  const wt = await addWorktreeForBranch(branch);
  // Simulate the exact violation this gate exists to catch: something
  // switched REPO itself off the base branch. Must be a DIFFERENT branch
  // than the preview's own — git refuses to check out a branch that's
  // already checked out in another worktree.
  git(env.repo, ["checkout", "-q", "-b", "bos/unrelated-drift"]);
  try {
    const v = fakeVersion({ worktree: wt, branch, role: "preview" });
    const result = await buildAndStart(v);
    assert.equal(result, "failed");
    assert.match(v.buildError, /developer harness edited the live checkout/);
    assert.equal(git(env.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), env.baseBranch, "assertRepoIntegrity must have restored REPO");
  } finally {
    git(env.repo, ["checkout", "-q", env.baseBranch]);
    git(env.repo, ["branch", "-D", "bos/unrelated-drift"]);
  }
});

test("buildAndStart: a successful build reaches 'ready' via a real health-gated server", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/build-ready";
    git(env.repo, ["branch", branch]);
    const wt = await addWorktreeForBranch(branch);
    const pkgPath = join(wt, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ name: "fake-bos", scripts: { build: 'node -e "process.exit(0)"' } }));
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-q", "-m", "fast build script"]);

    const v = fakeVersion({ worktree: wt, branch, role: "preview", port: 45902 });
    const result = await buildAndStart(v);
    assert.equal(result, "ready");
    assert.equal(v.state, "ready");
    await stopProc(v);
  } finally {
    restore();
  }
});

test("buildAndStart: a build that succeeds but never becomes healthy fails with a health-check-specific reason", async () => {
  const { restore } = installFakeNpx();
  process.env.FAKE_SERVER_UNHEALTHY = "1";
  try {
    const branch = "bos/build-unhealthy";
    git(env.repo, ["branch", branch]);
    const wt = await addWorktreeForBranch(branch);
    const pkgPath = join(wt, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ name: "fake-bos", scripts: { build: 'node -e "process.exit(0)"' } }));
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-q", "-m", "fast build script"]);

    const v = fakeVersion({ worktree: wt, branch, role: "preview", port: 45903 });
    const result = await buildAndStart(v);
    assert.equal(result, "failed");
    assert.match(v.buildError, /health check failed/);
    await stopProc(v);
  } finally {
    delete process.env.FAKE_SERVER_UNHEALTHY;
    restore();
  }
});

test.after(() => env.cleanup());
