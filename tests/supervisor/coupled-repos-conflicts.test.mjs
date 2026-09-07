// Unit tests for the conflict-detection/escalation branches of
// tools/supervisor/lib/coupled-repos.mjs not already covered by
// coupled-repos.test.mjs: coupledConflicts, resolveCoupledConflicts, and
// promoteCoupled's plumbing-merge (detached-HEAD primary checkout) and
// conflict-escalation paths (035-spec-promote-conflict-escalation). A tiny
// fake HTTP server stands in for base's /api/gitfs/reconcile job API,
// exactly like promote-safety.test.mjs / reconcile-client.test.mjs.
//   node --test tests/supervisor/coupled-repos-conflicts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, makeSpecStore, git } from "./_data-helpers.mjs";

let handler = () => { throw new Error("no handler configured for this test"); };
const fakeBase = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    const { status, json } = handler({ pathname: url.pathname, query: url.searchParams, body: body ? JSON.parse(body) : {} });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  });
});
await new Promise((resolve) => fakeBase.listen(0, "127.0.0.1", resolve));
process.env.BOS_PORT_BASE = String(fakeBase.address().port);
process.env.BOS_RECONCILE_POLL_MS = "10";

const env = makeSupervisorEnv("coupled-conflicts-");
const { coupledConflicts, resolveCoupledConflicts, promoteCoupled, mountCoupled } = await import("../../tools/supervisor/lib/coupled-repos.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);

function autoDoneHandler(outcome) {
  let started = false;
  return ({ pathname }) => {
    if (pathname === "/api/gitfs/reconcile" && !started) { started = true; return { status: 200, json: { jobId: "j1" } }; }
    return { status: 200, json: { phase: "done", outcome } };
  };
}

/** Simulates one intermediate "escalated" poll (which is what actually
 *  fires onEscalate — a DIFFERENT thing from outcome.status) before
 *  resolving to `outcome`. */
function autoEscalateThenDoneHandler(outcome, { devopsConversationId = "conv-live", sessionId = "sess-live" } = {}) {
  let started = false;
  let pollCount = 0;
  return ({ pathname }) => {
    if (pathname === "/api/gitfs/reconcile" && !started) { started = true; return { status: 200, json: { jobId: "j1" } }; }
    pollCount++;
    if (pollCount === 1) return { status: 200, json: { phase: "escalated", devopsConversationId, sessionId } };
    return { status: 200, json: { phase: "done", outcome } };
  };
}

test("coupledConflicts: no such branch at all — null, no conflict", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc1", "s1", "master");
  assert.equal(await coupledConflicts({ id: "s1", root: store, kind: "spec-store" }, "bos/never-created"), null);
});

test("coupledConflicts: a genuinely conflicting branch returns a description naming both sides", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc2", "s2", "master");
  writeFileSync(store + "/f.md", "shared ancestor\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "shared"]);
  git(store, ["branch", "bos/conflicting"]);
  git(store, ["checkout", "-q", "bos/conflicting"]);
  writeFileSync(store + "/f.md", "conflicting branch version\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "branch edit"]);
  git(store, ["checkout", "-q", "master"]);
  // Master ALSO diverges from the shared ancestor on the same line — without
  // this, "branch" is a pure fast-forward descendant of "master" and there is
  // nothing to conflict.
  writeFileSync(store + "/f.md", "master's own conflicting edit\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "master edit"]);

  const conflict = await coupledConflicts({ id: "s2", root: store, kind: "spec-store" }, "bos/conflicting");
  assert.ok(conflict, "must detect the conflict");
  assert.match(conflict, /s2: branch bos\/conflicting conflicts with master/);
});

test("resolveCoupledConflicts: no conflict at all — ok:true, no HTTP call", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc3", "s3", "master");
  git(store, ["branch", "bos/clean"]);
  handler = () => { throw new Error("must not be called — there is no conflict to escalate"); };
  const result = await resolveCoupledConflicts({ id: "s3", root: store, kind: "spec-store" }, "bos/clean", () => {});
  assert.deepEqual(result, { ok: true });
});

test("resolveCoupledConflicts: a conflict that resolves via the pipeline returns ok:true with the session id", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc4", "s4", "master");
  writeFileSync(store + "/f.md", "shared\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "shared"]);
  git(store, ["branch", "bos/resolves"]);
  git(store, ["checkout", "-q", "bos/resolves"]);
  writeFileSync(store + "/f.md", "branch\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "b"]);
  git(store, ["checkout", "-q", "master"]);
  writeFileSync(store + "/f.md", "master's own conflicting edit\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "master edit"]);

  handler = autoEscalateThenDoneHandler({ status: "success", sessionId: "sess-42" }, { devopsConversationId: "conv-42", sessionId: "sess-42" });
  const escalations = [];
  const result = await resolveCoupledConflicts({ id: "s4", root: store, kind: "spec-store" }, "bos/resolves", (conv, sess) => escalations.push([conv, sess]));
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "sess-42");
  assert.deepEqual(escalations, [["conv-42", "sess-42"]]);
});

test("resolveCoupledConflicts: a conflict the pipeline could not resolve returns ok:false with a rollback-tag message", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc5", "s5", "master");
  writeFileSync(store + "/f.md", "shared\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "shared"]);
  git(store, ["branch", "bos/unresolved"]);
  git(store, ["checkout", "-q", "bos/unresolved"]);
  writeFileSync(store + "/f.md", "branch\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "b"]);
  git(store, ["checkout", "-q", "master"]);
  writeFileSync(store + "/f.md", "master's own conflicting edit\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "master edit"]);

  handler = autoDoneHandler({ status: "failed", error: { message: "could not auto-resolve" }, rollbackTag: "bos/v-rollback", sessionId: "sess-99" });
  const result = await resolveCoupledConflicts({ id: "s5", root: store, kind: "spec-store" }, "bos/unresolved", () => {});
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, "sess-99");
  assert.match(result.message, /was not resolved/);
  assert.match(result.message, /bos\/v-rollback/);
});

test("resolveCoupledConflicts: the pipeline itself is unreachable — ok:false, promote must still stop here", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc6", "s6", "master");
  writeFileSync(store + "/f.md", "shared\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "shared"]);
  git(store, ["branch", "bos/unreachable"]);
  git(store, ["checkout", "-q", "bos/unreachable"]);
  writeFileSync(store + "/f.md", "branch\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "b"]);
  git(store, ["checkout", "-q", "master"]);
  writeFileSync(store + "/f.md", "master's own conflicting edit\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "master edit"]);

  handler = () => ({ status: 500, json: { error: "base down" } });
  const result = await resolveCoupledConflicts({ id: "s6", root: store, kind: "spec-store" }, "bos/unreachable", () => {});
  assert.equal(result.ok, false);
  assert.match(result.message, /could not escalate the conflict/);
});

test("promoteCoupled: a DETACHED-HEAD primary checkout merges via plumbing, never touching the working tree", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc7", "s7", "master");
  const masterTip = git(store, ["rev-parse", "master"]);
  const repo = { id: "s7", root: store, kind: "spec-store" };
  const dst = join(env.dataDir, "extra-specs-cc7-mount");
  await mountCoupled(repo, dst, "bos/plumbing");
  writeFileSync(dst + "/plumbing-feature.md", "# added via plumbing\n");
  git(dst, ["add", "-A"]);
  git(dst, ["commit", "-q", "-m", "plumbing feature"]);
  git(store, ["checkout", "-q", masterTip]); // detach HEAD on master's checkout — "busy"
  assert.throws(() => git(store, ["symbolic-ref", "--short", "HEAD"]), "precondition: HEAD really is detached");

  const warnings = [];
  await promoteCoupled(repo, "bos/plumbing", dst, warnings, () => {});

  assert.deepEqual(warnings, []);
  assert.equal(git(store, ["rev-parse", "master"]) === masterTip, false, "master's ref must have advanced");
  assert.throws(() => git(store, ["rev-parse", "--verify", "refs/heads/bos/plumbing"]), "the merged branch must be deleted");
  // Working tree (still checked out at the old detached commit) must be untouched by the plumbing merge.
  assert.equal(existsSync(store + "/plumbing-feature.md"), false, "plumbing merge must not touch the working tree");
  const recovered = store + "-recovered";
  git(store, ["worktree", "add", recovered, "master"]);
  assert.equal(existsSync(recovered + "/plumbing-feature.md"), true, "but the content must be on master's ref");
  git(store, ["worktree", "remove", "--force", recovered]);
});

test("promoteCoupled: a merge conflict after code-promote escalates and, once resolved, still lands the merge", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc8", "s8", "master");
  writeFileSync(store + "/f.md", "shared\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "shared"]);
  const repo = { id: "s8", root: store, kind: "spec-store" };
  const dst = join(env.dataDir, "extra-specs-cc8-mount");
  await mountCoupled(repo, dst, "bos/promote-conflict");
  writeFileSync(dst + "/f.md", "branch\n");
  git(dst, ["add", "-A"]);
  git(dst, ["commit", "-q", "-m", "b"]);
  // Master ALSO diverges from the shared ancestor on the same line — without
  // this the merge is a pure fast-forward and the escalation path this test
  // targets never fires.
  writeFileSync(store + "/f.md", "master's own conflicting edit\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "master edit"]);

  handler = autoDoneHandler({ status: "success", sessionId: "sess-77" });
  const warnings = [];
  await promoteCoupled(repo, "bos/promote-conflict", dst, warnings, () => {});

  assert.deepEqual(warnings, []);
  assert.throws(() => git(store, ["rev-parse", "--verify", "refs/heads/bos/promote-conflict"]), "the branch must be deleted once resolved");
});

test("promoteCoupled: a merge conflict that the pipeline can't resolve is recorded as a warning, base left clean", async () => {
  const store = makeSpecStore(env.dataDir + "/extra-specs-cc9", "s9", "master");
  writeFileSync(store + "/f.md", "shared\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "shared"]);
  const repo = { id: "s9", root: store, kind: "spec-store" };
  const dst = join(env.dataDir, "extra-specs-cc9-mount");
  await mountCoupled(repo, dst, "bos/promote-unresolved");
  writeFileSync(dst + "/f.md", "branch\n");
  git(dst, ["add", "-A"]);
  git(dst, ["commit", "-q", "-m", "b"]);
  writeFileSync(store + "/f.md", "master's own conflicting edit\n");
  git(store, ["add", "-A"]);
  git(store, ["commit", "-q", "-m", "master edit"]);
  const masterTipBefore = git(store, ["rev-parse", "master"]);

  handler = autoDoneHandler({ status: "failed", error: { message: "still conflicted" }, rollbackTag: "bos/v-x" });
  const warnings = [];
  await promoteCoupled(repo, "bos/promote-unresolved", dst, warnings, () => {});

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /merge of bos\/promote-unresolved FAILED after code promote/);
  assert.equal(git(store, ["rev-parse", "master"]), masterTipBefore, "master must be untouched by the aborted merge");
  assert.equal(git(store, ["status", "--porcelain"]), "", "the working tree must be clean — merge --abort must have run");
});

test.after(async () => {
  env.cleanup();
  await new Promise((resolve) => fakeBase.close(resolve));
});
