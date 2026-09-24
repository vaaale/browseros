// Unit tests for tools/supervisor/lib/preview.mjs's preview lifecycle:
// provisioning (fresh/reuse/dedup), restorePreviews, stop/discard, begin,
// build, activate, resume, and the small read-only helpers (liveBranch,
// previewChanges, listBranches). firstSourceRemote/pullBaseBeforeNewBranch
// are already covered by their own dedicated test files. Uses the fake-npx
// trick (see _server-helpers.mjs) so activate/resumePreview/buildPreview can
// reach a real "ready" state.
//   node --test tests/supervisor/preview-lifecycle.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";
import { installFakeNpx } from "./_server-helpers.mjs";

process.env.BOS_HEALTH_TIMEOUT_MS = "5000";

const env = makeSupervisorEnv("preview-lifecycle-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const {
  restorePreviews,
  provisionPreview,
  stopPreview,
  discardPreview,
  beginPreview,
  buildPreview,
  activate,
  resumePreview,
  liveBranch,
  previewChanges,
  listBranches,
} = await import("../../tools/supervisor/lib/preview.mjs");
const { state, previews } = await import("../../tools/supervisor/lib/state.mjs");
const { stopProc } = await import("../../tools/supervisor/lib/proc.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

async function cleanupPreview(branch) {
  const p = previews.get(branch);
  if (p) await stopProc(p);
  previews.delete(branch);
}

test("provisionPreview: fresh provision creates a branch, worktree, data clone, port, and the user-apps symlink", async () => {
  const branch = "bos/testfixture-fresh-provision";
  const p = await provisionPreview(branch);
  try {
    assert.equal(p.role, "preview");
    assert.equal(p.branch, branch);
    assert.equal(p.state, "not-built");
    assert.ok(p.port > 0);
    assert.equal(existsSync(p.worktree), true);
    assert.equal(existsSync(p.dataDir), true);
    assert.doesNotThrow(() => git(env.repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));

    const link = join(p.worktree, "data", "user-apps");
    const st = lstatSync(link);
    assert.equal(st.isSymbolicLink(), true);
    assert.equal(readlinkSync(link), join(p.dataDir, "user-apps"));
  } finally {
    await cleanupPreview(branch);
  }
});

test("provisionPreview: an already-provisioned branch returns the SAME object, not a fresh re-provision", async () => {
  const branch = "bos/testfixture-reuse-provision";
  const first = await provisionPreview(branch);
  try {
    const marker = join(first.worktree, "marker.txt");
    writeFileSync(marker, "still here\n");
    const second = await provisionPreview(branch);
    assert.equal(second, first, "must be the exact same object, not a new provision");
    assert.equal(existsSync(marker), true);
  } finally {
    await cleanupPreview(branch);
  }
});

test("provisionPreview: two concurrent calls for the same not-yet-provisioned branch share ONE in-flight provision", async () => {
  const branch = "bos/testfixture-concurrent-provision";
  const [a, b] = await Promise.all([provisionPreview(branch), provisionPreview(branch)]);
  try {
    assert.equal(a, b, "both callers must get the identical object — no duplicate worktree/port allocation");
  } finally {
    await cleanupPreview(branch);
  }
});

// This test used to assert `existsSync(a.worktree) === true` — that discovery
// MATERIALIZES every branch it finds. That was the defect, not the contract:
// eagerly provisioning 21 abandoned branches copied ~200 GB and filled a
// production disk. Restated to assert the property that is actually wanted —
// discovery registers, first use provisions. The cost side is covered in
// tests/supervisor/preview-restore-lazy.test.mjs.
test("restorePreviews: registers bos/* branches not yet tracked as dormant previews, and skips ones already registered", async () => {
  git(env.repo, ["branch", "bos/testfixture-restore-a"]);
  git(env.repo, ["branch", "bos/testfixture-restore-b"]);
  // Already registered — restorePreviews must leave it alone (identity check).
  const already = { role: "preview", branch: "bos/testfixture-restore-b", worktree: "/sentinel", dataDir: "/sentinel", port: 1, state: "ready", proc: null, provisioned: true };
  previews.set("bos/testfixture-restore-b", already);
  try {
    await restorePreviews();
    const a = previews.get("bos/testfixture-restore-a");
    assert.ok(a, "bos/testfixture-restore-a must have been registered");
    assert.equal(a.state, "not-built");
    assert.equal(a.provisioned, false, "discovery must not materialize a worktree or data clone");
    assert.equal(a.worktree, null, "a dormant preview has no working directory yet");
    assert.equal(previews.get("bos/testfixture-restore-b"), already, "an already-tracked preview must not be re-registered");
  } finally {
    await cleanupPreview("bos/testfixture-restore-a");
    previews.delete("bos/testfixture-restore-b");
  }
});

test("liveBranch: a dormant preview reports its OWN branch, never the base branch", async () => {
  git(env.repo, ["branch", "bos/testfixture-dormant-live-branch"]);
  await restorePreviews();
  const p = previews.get("bos/testfixture-dormant-live-branch");
  try {
    assert.equal(p.provisioned, false);
    // Regression guard: liveBranch runs `git rev-parse --abbrev-ref HEAD` in
    // `v.worktree`. For a dormant preview that is null, which would fall
    // through to the Supervisor's own cwd and report BASE — making every
    // unprovisioned preview look like base in the toolbar.
    assert.equal(await liveBranch(p), "bos/testfixture-dormant-live-branch");
  } finally {
    previews.delete("bos/testfixture-dormant-live-branch");
  }
});

test("previewChanges: a dormant preview still reports the branch's real diff against base", async () => {
  const branch = "bos/testfixture-dormant-changes";
  git(env.repo, ["branch", branch]);
  // Commit a file ON the branch without ever provisioning a preview for it.
  git(env.repo, ["checkout", "-q", branch]);
  writeFileSync(join(env.repo, "only-on-branch.txt"), "x\n");
  git(env.repo, ["add", "-A"]);
  git(env.repo, ["commit", "-q", "-m", "branch-only change"]);
  git(env.repo, ["checkout", "-q", env.baseBranch]);

  await restorePreviews();
  try {
    const { candidate } = await previewChanges(branch);
    assert.ok(candidate, "a registered preview must not report `candidate: null` just because it is unprovisioned");
    assert.deepEqual(
      candidate.files.map((f) => f.path),
      ["only-on-branch.txt"],
      "answering 'no changes' for an unprovisioned branch would be a wrong answer dressed as an empty one",
    );
  } finally {
    previews.delete(branch);
  }
});

test("stopPreview: unknown branch is a silent no-op; an existing preview stops its server but keeps the worktree/branch", async () => {
  await stopPreview("bos/testfixture-never-existed"); // must not throw

  const branch = "bos/testfixture-stop-me";
  const p = await provisionPreview(branch);
  try {
    p.proc = null; // not actually running — stopProc(p) must still resolve cleanly
    await stopPreview(branch);
    assert.equal(p.state, "stopped");
    assert.equal(p.proc, null);
    assert.equal(existsSync(p.worktree), true, "worktree must survive a Stop");
  } finally {
    await cleanupPreview(branch);
  }
});

test("discardPreview: a REGISTERED preview is fully torn down — server, worktree, data clone, and branch", async () => {
  const branch = "bos/testfixture-discard-registered";
  const p = await provisionPreview(branch);
  const { worktree, dataDir } = p;
  const { warnings } = await discardPreview(branch);
  assert.deepEqual(warnings, []);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(dataDir), false);
  assert.throws(() => git(env.repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
  assert.equal(previews.has(branch), false);
});

test("discardPreview: with no REGISTERED preview object, only the coupled repos (spec stores/user-apps) are cleaned up — there is no worktree/branch to resolve the code side from", async () => {
  const branch = "bos/testfixture-discard-unregistered";
  git(env.repo, ["branch", branch]);
  assert.equal(previews.has(branch), false, "precondition: never provisioned this run");
  const { warnings } = await discardPreview(branch);
  // user-apps never had a matching branch (this preview was never actually
  // provisioned) — that specific, harmless "branch not found" is expected.
  assert.ok(warnings.every((w) => /user-apps.*not found/s.test(w)), `unexpected warnings: ${warnings.join("; ")}`);
  assert.doesNotThrow(
    () => git(env.repo, ["rev-parse", "--verify", `refs/heads/${branch}`]),
    "this recovery path has no worktree to resolve the code branch from, so it is deliberately left alone",
  );
  git(env.repo, ["branch", "-D", branch]);
});

test("beginPreview: provisions if needed and mounts every spec store; returns the version plus any mount errors", async () => {
  const branch = "bos/testfixture-begin-test";
  try {
    const v = await beginPreview(branch);
    assert.equal(v.branch, branch);
    assert.equal(v.mountErrors, undefined, "no spec stores configured — nothing to fail");
  } finally {
    await cleanupPreview(branch);
  }
});

test("buildPreview: provisions (if needed) and builds to ready via a real health-gated server", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/testfixture-build-preview";
    const st = await buildPreview(branch);
    assert.equal(st, "ready");
    assert.equal(previews.get(branch).state, "ready");
    await cleanupPreview(branch);
  } finally {
    restore();
  }
});

test("activate: base branch (or no branch) resolves immediately without provisioning anything", async () => {
  assert.deepEqual(await activate(state.baseBranch), { base: true, state: "ready" });
  assert.deepEqual(await activate(""), { base: true, state: "ready" });
});

test("activate: an already-ready preview resolves immediately, unchanged", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/testfixture-activate-ready";
    await buildPreview(branch);
    try {
      const result = await activate(branch);
      assert.deepEqual(result, { branch, state: "ready" });
    } finally {
      await cleanupPreview(branch);
    }
  } finally {
    restore();
  }
});

test("activate: a not-built preview starts building in the background and eventually becomes ready", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/testfixture-activate-background";
    const result = await activate(branch);
    assert.equal(result.branch, branch);
    assert.equal(result.state, "building");
    const p = previews.get(branch);
    for (let i = 0; i < 100 && p.state === "building"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.state, "ready");
    await cleanupPreview(branch);
  } finally {
    restore();
  }
});

test("activate: a background build failure is recorded on the preview, not thrown to the caller", async () => {
  const { restore } = installFakeNpx();
  process.env.FAKE_SERVER_UNHEALTHY = "1";
  try {
    const branch = "bos/testfixture-activate-fails";
    await activate(branch);
    const p = previews.get(branch);
    for (let i = 0; i < 100 && p.state === "building"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.state, "failed");
    assert.ok(p.buildError);
    await cleanupPreview(branch);
  } finally {
    delete process.env.FAKE_SERVER_UNHEALTHY;
    restore();
  }
});

test("resumePreview: unknown branch throws", async () => {
  await assert.rejects(resumePreview("bos/testfixture-never-resumed"), /no preview to resume/);
});

test("resumePreview: an already-ready, still-running preview is a no-op", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/testfixture-resume-noop";
    await buildPreview(branch);
    try {
      const p = previews.get(branch);
      const result = await resumePreview(branch);
      assert.equal(result, p);
      assert.equal(p.state, "ready");
    } finally {
      await cleanupPreview(branch);
    }
  } finally {
    restore();
  }
});

test("resumePreview: a STOPPED preview resumes from its existing build output without a full rebuild", async () => {
  const { restore } = installFakeNpx();
  try {
    const branch = "bos/testfixture-resume-stopped";
    await buildPreview(branch);
    const p = previews.get(branch);
    await stopPreview(branch);
    assert.equal(p.state, "stopped");
    try {
      const result = await resumePreview(branch);
      assert.equal(result, p);
      assert.equal(p.state, "ready");
      assert.equal(p.buildError, "");
    } finally {
      await cleanupPreview(branch);
    }
  } finally {
    restore();
  }
});

test("liveBranch: resolves the worktree's real current branch; falls back to v.branch on a detached/unreadable HEAD", async () => {
  const branch = "bos/testfixture-live-branch";
  const p = await provisionPreview(branch);
  try {
    assert.equal(await liveBranch(p), branch);
    assert.equal(await liveBranch(null), undefined);

    const detachedTip = git(p.worktree, ["rev-parse", "HEAD"]);
    git(p.worktree, ["checkout", "-q", detachedTip]);
    assert.equal(await liveBranch(p), branch, "detached HEAD falls back to the version's own logical branch");

    const fake = { worktree: "/nonexistent/not-a-repo", branch: "bos/testfixture-fallback" };
    assert.equal(await liveBranch(fake), "bos/testfixture-fallback");
  } finally {
    await cleanupPreview(branch);
  }
});

test("previewChanges: no preview for the branch returns { ok:true, candidate:null }; an existing preview lists its real diff", async () => {
  assert.deepEqual(await previewChanges("bos/testfixture-no-such-preview"), { ok: true, candidate: null });
  assert.deepEqual(await previewChanges(undefined), { ok: true, candidate: null });

  const branch = "bos/testfixture-preview-changes";
  const p = await provisionPreview(branch);
  try {
    writeFileSync(join(p.worktree, "changed.txt"), "a real edit\n");
    git(p.worktree, ["add", "-A"]);
    git(p.worktree, ["commit", "-q", "-m", "edit"]);
    const result = await previewChanges(branch);
    assert.equal(result.ok, true);
    assert.equal(result.candidate.branch, branch);
    assert.ok(result.candidate.files.some((f) => f.path === "changed.txt" && f.status === "A"));
  } finally {
    await cleanupPreview(branch);
  }
});

test("listBranches: always includes the base branch, plus every real git branch", async () => {
  git(env.repo, ["branch", "bos/testfixture-list-a"]);
  git(env.repo, ["branch", "bos/testfixture-list-b"]);
  const branches = await listBranches();
  assert.ok(branches.includes(env.baseBranch));
  assert.ok(branches.includes("bos/testfixture-list-a"));
  assert.ok(branches.includes("bos/testfixture-list-b"));
  git(env.repo, ["branch", "-D", "bos/testfixture-list-a"]);
  git(env.repo, ["branch", "-D", "bos/testfixture-list-b"]);
});

test.after(() => env.cleanup());
