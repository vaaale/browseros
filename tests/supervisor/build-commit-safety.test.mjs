// Regression tests for tools/supervisor/lib/build.mjs's buildAndStart commit
// step — the single mechanism the whole self-modification system relies on
// to guarantee "an agent's edit is never left uncommitted" (the explicit
// design intent behind claude-runner.ts's "always build" comment).
//
// Two bugs found in review, both fixed the same way — abort loudly instead
// of silently proceeding as if nothing were wrong:
//  1. `git add -A` was wrapped in a swallowed `.catch(() => {})`. A failed
//     add left NOTHING staged, so the immediately-following `git commit`
//     would find nothing to commit and hit the harmless "nothing to
//     commit" branch — silently reporting a candidate as clean when its
//     edits were never durably committed at all.
//  2. Conversely, the commit MUST happen before the (possibly slow, always
//     more failure-prone) `npm run build` step — a build failure must never
//     take the commit down with it. This is the flip side of #1 and was
//     already correct; it's tested here as the guarantee the whole design
//     depends on, not as a new fix.
//
// Uses a fake, near-instant "build" script (`node -e "process.exit(N)"`)
// instead of a real Next.js build — this suite is testing the commit
// safety around the build step, not the build itself.
//
//   node --test tests/supervisor/build-commit-safety.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("build-commit-safety-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true }); // addWorktreeForBranch hydrates this
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

// Every test in this file wants the build step to fail, fast and
// deterministically — none of them need (or can afford: no real `next` is
// installed, and a failed health-gate would wait out the full 120s timeout
// before giving up) a build that actually succeeds and reaches startProc.
writeFileSync(join(env.repo, "package.json"), JSON.stringify({ name: "fake-bos", scripts: { build: "node -e \"process.exit(1)\"" } }, null, 2));
git(env.repo, ["add", "-A"]);
git(env.repo, ["commit", "-q", "-m", "package.json: build always fails (test fixture)"]);

const { addWorktreeForBranch } = await import("../../tools/supervisor/lib/worktree.mjs");
const { buildAndStart } = await import("../../tools/supervisor/lib/build.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
const { state } = await import("../../tools/supervisor/lib/state.mjs");
initLogStore(env.dataDir);
// buildAndStart's own post-commit safety gate (assertRepoIntegrity) compares
// REPO's live branch against state.baseBranch — matching main()'s own boot
// sequence, which resolves this from REPO itself before anything else runs.
state.baseBranch = env.baseBranch;

function fakeVersion(overrides) {
  return { role: "preview", state: "not-built", proc: null, buildError: "", buildLog: "", commit: undefined, port: 45999, ...overrides };
}

test("buildAndStart: a worktree that isn't a git repo at all aborts at the `git add` step — never silently proceeds", async () => {
  const notAWorktree = join(env.worktrees, "not-a-git-repo");
  mkdirSync(notAWorktree, { recursive: true });
  writeFileSync(join(notAWorktree, "some-file.txt"), "irrelevant\n");

  const v = fakeVersion({ worktree: notAWorktree, branch: "bos/testfixture-not-a-repo", role: "preview" });
  const result = await buildAndStart(v);

  assert.equal(result, "failed");
  assert.equal(v.state, "failed");
  assert.match(v.buildError, /failed to stage candidate changes/i, "must name the STAGING failure specifically, not a generic/misleading reason");
});

test("buildAndStart: a build FAILURE never loses the commit — the edit lands before npm run build even runs", async () => {
  git(env.repo, ["branch", "bos/testfixture-build-fails"]);
  const wt = await addWorktreeForBranch("bos/testfixture-build-fails"); // inherits REPO's always-fails build script

  // The agent's in-flight, UNCOMMITTED edit.
  writeFileSync(join(wt, "agent-edit.txt"), "the change the user actually asked for\n");
  assert.notEqual(git(wt, ["status", "--porcelain"]), "", "precondition: the worktree must be dirty before buildAndStart runs");

  const v = fakeVersion({ worktree: wt, branch: "bos/testfixture-build-fails", role: "preview" });
  const result = await buildAndStart(v);

  assert.equal(result, "failed");
  assert.match(v.buildError, /node -e|process\.exit/i, "the failure reason must be the BUILD's own output, not a commit-related message");
  assert.doesNotMatch(v.buildError, /commit|stage/i, "must not blame the commit for a build failure");
  assert.equal(git(wt, ["status", "--porcelain"]), "", "the worktree must be clean — the edit was committed despite the build failing");
  const committed = readFileSync(join(wt, "agent-edit.txt"), "utf8");
  assert.equal(committed, "the change the user actually asked for\n");
  const lastCommitFiles = git(wt, ["show", "--stat", "--oneline", "HEAD"]);
  assert.match(lastCommitFiles, /agent-edit\.txt/, "the edit must be in the most recent commit");
});

test("buildAndStart: nothing to commit (clean worktree) is not treated as a commit failure", async () => {
  git(env.repo, ["branch", "bos/testfixture-build-clean"]);
  const wt = await addWorktreeForBranch("bos/testfixture-build-clean");
  assert.equal(git(wt, ["status", "--porcelain"]), "", "precondition: freshly-provisioned worktree is clean");
  const tipBefore = git(wt, ["rev-parse", "HEAD"]);

  // Build fails too (fast, deterministic) so this stops at runBuild and never
  // reaches startProc/waitHealthy (a real `next start` isn't available
  // here, and health-gating would need the full 120s timeout to give up) —
  // the point of this test is only "nothing to commit" isn't misreported as
  // a commit failure, which the build outcome doesn't affect either way.
  const v = fakeVersion({ worktree: wt, branch: "bos/testfixture-build-clean", role: "preview" });
  const result = await buildAndStart(v);

  assert.equal(result, "failed");
  assert.equal(git(wt, ["rev-parse", "HEAD"]), tipBefore, "a clean worktree must not gain a phantom commit");
  assert.match(v.buildError, /node -e|process\.exit/i, "must fail for a BUILD reason");
  assert.doesNotMatch(v.buildError, /commit|stage/i, "'nothing to commit' must not be reported as a failure reason");
});

test.after(() => env.cleanup());
