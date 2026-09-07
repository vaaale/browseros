// Unit tests for tools/supervisor/lib/reconcile-client.mjs — the shared
// reconciliation pipeline client promote.mjs/coupled-repos.mjs poll during a
// promote (001-external-repo-integration US6, 035-spec-promote-conflict-
// escalation). A tiny fake HTTP server stands in for base's own
// /api/gitfs/reconcile job API (same technique as promote-safety.test.mjs).
// BOS_PORT_BASE must be set to the fake server's port BEFORE any
// tools/supervisor module is imported — config.mjs freezes it at first
// import.
//   node --test tests/supervisor/reconcile-client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let handler = () => { throw new Error("no handler configured for this test"); };
const fakeBase = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    const parsedBody = body ? JSON.parse(body) : {};
    const { status, json } = handler({ method: req.method, pathname: url.pathname, query: url.searchParams, body: parsedBody });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  });
});
await new Promise((resolve) => fakeBase.listen(0, "127.0.0.1", resolve));
process.env.BOS_PORT_BASE = String(fakeBase.address().port);
process.env.BOS_RECONCILE_POLL_MS = "10"; // fast polling for these tests

const { reconcileViaApi, requireReconciled } = await import("../../tools/supervisor/lib/reconcile-client.mjs");
const { state } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "reconcile-client-log-"));
initLogStore(dataDir);
state.baseBranch = "claude";

function git(cwd, args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

test("reconcileViaApi: start failing (non-200 or missing jobId) throws immediately", async () => {
  handler = () => ({ status: 500, json: { error: "boom" } });
  await assert.rejects(reconcileViaApi({ repoPath: "/x" }), /reconcile job failed to start/);

  handler = () => ({ status: 200, json: {} }); // 200 but no jobId
  await assert.rejects(reconcileViaApi({ repoPath: "/x" }), /reconcile job failed to start/);
});

test("reconcileViaApi: escalation fires onEscalate exactly once even when polled while still escalated, then resolves on done", async () => {
  let poll = 0;
  handler = ({ pathname }) => {
    if (pathname === "/api/gitfs/reconcile" && poll === 0) { poll++; return { status: 200, json: { jobId: "job-1" } }; }
    poll++;
    if (poll <= 3) return { status: 200, json: { phase: "escalated", devopsConversationId: "conv-1", sessionId: "sess-1" } };
    return { status: 200, json: { phase: "done", outcome: { status: "success", method: "merge-squash" } } };
  };
  const escalations = [];
  const outcome = await reconcileViaApi({ repoPath: "/x" }, (conv, sess) => escalations.push([conv, sess]));
  assert.deepEqual(outcome, { status: "success", method: "merge-squash" });
  assert.deepEqual(escalations, [["conv-1", "sess-1"]], "onEscalate must fire exactly once, not once per poll");
});

test("reconcileViaApi: a non-200 poll response throws", async () => {
  let started = false;
  handler = () => {
    if (!started) { started = true; return { status: 200, json: { jobId: "job-2" } }; }
    return { status: 503, json: { error: "unavailable" } };
  };
  await assert.rejects(reconcileViaApi({ repoPath: "/x" }), /reconcile job poll failed/);
});

test("requireReconciled: status 'failed' throws with the suggestion appended when present", async () => {
  const cand = { branch: "bos/x", state: "escalated" };
  await assert.rejects(
    requireReconciled(cand, { status: "failed", error: { message: "merge conflict", suggestion: "resolve manually" } }, "/repo", "test op"),
    /test op failed: merge conflict \(resolve manually\)/,
  );
});

test("requireReconciled: status 'timed-out' throws naming the conversation", async () => {
  const cand = { branch: "bos/x", state: "escalated" };
  await assert.rejects(
    requireReconciled(cand, { status: "timed-out", devopsConversationId: "conv-9" }, "/repo", "test op"),
    /did not finish within the wait limit.*conv-9/s,
  );
});

test("requireReconciled: status 'success' is a no-op — does not touch cand.state", async () => {
  const cand = { branch: "bos/x", state: "ready" };
  await requireReconciled(cand, { status: "success" }, "/repo", "test op");
  assert.equal(cand.state, "ready");
});

test("requireReconciled: status 'escalated' with a CLEAN repo sets ready and clears the conversation id", async () => {
  const repo = mkdtempSync(join(tmpdir(), "reconcile-clean-repo-"));
  try {
    git(repo, ["init", "-q"]);
    writeFileSync(join(repo, "f"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    const cand = { branch: "bos/x", state: "escalated", devopsConversationId: "conv-1" };
    await requireReconciled(cand, { status: "escalated", devopsConversationId: "conv-1" }, repo, "test op");
    assert.equal(cand.state, "ready");
    assert.equal(cand.devopsConversationId, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("requireReconciled: status 'escalated' with a DIRTY repo throws — resolution doesn't look complete", async () => {
  const repo = mkdtempSync(join(tmpdir(), "reconcile-dirty-repo-"));
  try {
    git(repo, ["init", "-q"]);
    writeFileSync(join(repo, "f"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    writeFileSync(join(repo, "f"), "uncommitted change\n");
    const cand = { branch: "bos/x", state: "escalated" };
    await assert.rejects(
      requireReconciled(cand, { status: "escalated", devopsConversationId: "conv-1" }, repo, "test op"),
      /still has uncommitted\/conflicted changes/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("requireReconciled: status 'escalated' but the repo can't even be read — throws rather than assuming clean", async () => {
  const cand = { branch: "bos/x", state: "escalated" };
  await assert.rejects(
    requireReconciled(cand, { status: "escalated", devopsConversationId: "conv-1" }, "/nonexistent/not-a-repo", "test op"),
    /could not verify .* is clean after DevOps Agent escalation/,
  );
});

test.after(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  await new Promise((resolve) => fakeBase.close(resolve));
});
