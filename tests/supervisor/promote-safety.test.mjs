// Integration tests for tools/supervisor/lib/promote.mjs's safety ordering
// (042-worktree-collision hardening) — the single most important fix from
// this review.
//
// Regression: `commitCoupled`'s failure used to be caught and only WARNED
// about (`.catch((e) => slog("warn", ...))`), immediately before
// `promoteCoupled` (called later, after the code promote's point of no
// return) tears the SAME worktree down with `git worktree remove --force` —
// which silently discards whatever wasn't committed. A failed commit meant
// silent, permanent loss of exactly the content this whole coupling
// mechanism (spec stores AND user-apps, the data-clone-resident marketplace
// repo) exists to protect. The fix aborts the promote at the commit step
// instead of proceeding to destroy it.
//
// Runs `promote()` for real (real git, real worktrees) but in "reused" mode
// (`state.base.reused = true`), the one path that never spawns a real
// `next build`/`next start`/health-gate — it only merges, tags, and returns.
// `reconcileViaApi` still makes a real HTTP call to what it believes is
// base's own Next.js server (`/api/gitfs/reconcile`); a tiny fake HTTP
// server stands in for it here so this stays a fast, offline unit test.
//
//   node --test tests/supervisor/promote-safety.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";

// The fake server must be listening, and BOS_PORT_BASE set to its port,
// BEFORE any tools/supervisor module is imported — config.mjs reads
// BOS_PORT_BASE once, at first import, and freezes it for this process.
const fakeBase = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/gitfs/reconcile") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "POST") return res.end(JSON.stringify({ jobId: "fake-job" }));
    return res.end(JSON.stringify({ phase: "done", outcome: { status: "success", method: "fake-merge-squash" } }));
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `unhandled in fake base server: ${req.method} ${url.pathname}` }));
});
await new Promise((resolve) => fakeBase.listen(0, "127.0.0.1", resolve));
process.env.BOS_PORT_BASE = String(fakeBase.address().port);
process.env.BOS_PUSH_MODE = "manual"; // skip pushOriginViaBaseApi entirely — not what this suite is about

const env = makeSupervisorEnv("promote-safety-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true }); // addWorktreeForBranch hydrates this
writeFileSync(join(env.repo, "node_modules", ".keep"), "");

const { addWorktreeForBranch } = await import("../../tools/supervisor/lib/worktree.mjs");
const { provisionClone } = await import("../../tools/supervisor/lib/worktree.mjs");
const { mountCoupled, ensureAppsRepo } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
const { promote } = await import("../../tools/supervisor/lib/promote.mjs");
const { state, previews } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);

state.baseBranch = env.baseBranch; // "claude"

/** Provisions a REAL candidate preview: a code worktree with one new commit,
 *  a data clone with user-apps mounted on the same branch. Mirrors what
 *  beginPreview/buildAndStart would set up, minus ever starting a server. */
async function makeCandidate(branch, { editFile = "feature.txt", editContent = "a real feature\n" } = {}) {
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

function resetBaseToReused() {
  const commit = git(env.repo, ["rev-parse", "HEAD"]);
  state.base = { role: "base", branch: state.baseBranch, reused: true, port: fakeBase.address().port, state: "ready", proc: null, commit };
}

test("promote: a corrupted user-apps mount aborts BEFORE the code ref moves — nothing is destroyed, nothing is promoted", async () => {
  resetBaseToReused();
  const branch = "bos/testfixture-promote-abort";
  const { userAppsDst } = await makeCandidate(branch);
  const baseTipBefore = git(env.repo, ["rev-parse", state.baseBranch]);

  // Corrupt the mounted user-apps worktree's git state (points at a gitdir
  // that doesn't exist) so `git add -A` inside commitCoupled fails outright
  // — deterministic and portable, unlike relying on OS file permissions.
  writeFileSync(join(userAppsDst, ".git"), "gitdir: /nonexistent/broken-gitdir\n");
  writeFileSync(join(userAppsDst, "in-flight-work.txt"), "an app install that never got committed\n");

  await assert.rejects(promote(branch), (err) => {
    assert.match(err.message, /could not commit pending user-apps changes/i);
    return true;
  });

  assert.equal(git(env.repo, ["rev-parse", state.baseBranch]), baseTipBefore, "base's branch ref must NOT have moved");
  assert.equal(existsSync(userAppsDst), true, "the coupled worktree must still exist — never reached the destructive removeCoupledWorktree step");
  assert.equal(readFileSync(join(userAppsDst, "in-flight-work.txt"), "utf8"), "an app install that never got committed\n", "the uncommitted work must still be there, untouched");
  assert.ok(previews.has(branch), "the preview must still be registered — promote can be retried once the corruption is fixed");
  previews.delete(branch); // done with this scenario; env.cleanup() handles the corrupted worktree's files regardless
});

test("promote: a clean candidate merges code AND coupled content, advances base, tears down the preview", async () => {
  resetBaseToReused();
  const branch = "bos/testfixture-promote-success";
  const { worktree, dataDir, userAppsDst, commit } = await makeCandidate(branch, { editFile: "success.txt", editContent: "shipped\n" });
  mkdirSync(join(userAppsDst, "items", "widget"), { recursive: true });
  writeFileSync(join(userAppsDst, "items", "widget", "app.json"), JSON.stringify({ id: "widget" }));
  git(userAppsDst, ["add", "-A"]);
  git(userAppsDst, ["commit", "-q", "-m", "install widget"]);

  const result = await promote(branch);

  assert.match(result.tag, /^bos\/v\d{4}-\d\d-\d\d-\d\d_\d\d_\d\d$/, "must leave a durable rollback tag");
  assert.equal(git(env.repo, ["rev-parse", state.baseBranch]), commit, "base must fast-forward to the candidate's commit");
  assert.equal(existsSync(join(env.repo, "success.txt")), true, "the merged code must be checked out in REPO");
  assert.equal(existsSync(join(env.dataDir, "user-apps", "items", "widget", "app.json")), true, "the installed item must have merged into canonical user-apps");
  assert.equal(existsSync(worktree), false, "the candidate's code worktree must be torn down");
  assert.equal(existsSync(dataDir), false, "the candidate's data clone must be torn down");
  assert.equal(previews.has(branch), false, "the preview must be gone from the registry");
  assert.throws(() => git(env.repo, ["rev-parse", "--verify", `refs/heads/${branch}`]), "the feature branch must be deleted");
});

test.after(async () => {
  env.cleanup();
  await new Promise((resolve) => fakeBase.close(resolve));
});
