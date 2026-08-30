import http from "node:http";
import { BASE_PORT, RECONCILE_POLL_MS } from "./config.mjs";
import { git } from "./gitutil.mjs";
import { state } from "./state.mjs";
import { slog } from "./log.mjs";

// POST a JSON body to the Next.js server on BASE_PORT and parse the JSON
// response. Same-host, same-trust-domain call (see /api/gitfs/reconcile's
// own comment) — no auth, matching how /api/health is already probed.
function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { hostname: "127.0.0.1", port: BASE_PORT, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch (e) { reject(new Error(`invalid JSON response from ${path}: ${e.message}`)); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: BASE_PORT, path }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { reject(new Error(`invalid JSON response from ${path}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run the shared reconciliation pipeline (001-external-repo-integration,
// User Story 6) against the Next.js server's /api/gitfs/reconcile job API.
// Job-based (not one blocking POST) so `onEscalate` fires — and this
// function's own poll loop, running inside the SAME still-executing
// promote() call, is what makes the wait survive a browser refresh: nothing
// about it is tied to the original /control/promote HTTP connection.
export async function reconcileViaApi(opts, onEscalate) {
  const start = await postJson("/api/gitfs/reconcile", opts);
  if (start.status !== 200 || !start.body?.jobId) {
    throw new Error(`reconcile job failed to start: ${JSON.stringify(start.body)}`);
  }
  const jobId = start.body.jobId;
  slog("info", "promote", `reconcile job started (${opts.repoPath})`, { branch: state.baseBranch, versionLabel: "base", data: { jobId } });

  let sawEscalation = false;
  for (;;) {
    const poll = await getJson(`/api/gitfs/reconcile?jobId=${encodeURIComponent(jobId)}`);
    if (poll.status !== 200) {
      throw new Error(`reconcile job poll failed: ${JSON.stringify(poll.body)}`);
    }
    const { phase, devopsConversationId, sessionId, outcome } = poll.body;
    if (phase === "escalated" && !sawEscalation) {
      sawEscalation = true;
      slog("warn", "promote", `reconcile job escalated to the conflict-resolution agent (${opts.repoPath})`, {
        branch: state.baseBranch,
        versionLabel: "base",
        data: { jobId, devopsConversationId, sessionId },
      });
      // 035 (FR-018): the resolution session id is surfaced the MOMENT the
      // pipeline escalates — the Build Studio conflict pane has already
      // auto-launched by then, and the promote's own state can point at it
      // without waiting for the (possibly long) resolution to finish.
      onEscalate?.(devopsConversationId, sessionId);
    }
    if (phase === "done") {
      slog("info", "promote", `reconcile job done (${opts.repoPath}): ${outcome.status}${outcome.method ? ` via ${outcome.method}` : ""}`, {
        branch: state.baseBranch,
        versionLabel: "base",
        data: { jobId, outcome },
      });
      return outcome;
    }
    await sleep(RECONCILE_POLL_MS);
  }
}

// Verify the shared reconciliation pipeline's outcome and clear/leave the
// preview's interim "escalated" indicator accordingly. Throws (leaving
// cand.state="escalated" in place for timed-out/unverified cases, so the UI
// keeps pointing at the conversation) unless the target is genuinely clean
// and mergeable.
export async function requireReconciled(cand, outcome, repoPath, label) {
  if (outcome.status === "failed") {
    const suggestion = outcome.error?.suggestion ? ` (${outcome.error.suggestion})` : "";
    throw new Error(`${label} failed: ${outcome.error?.message || "unknown error"}${suggestion}`);
  }
  if (outcome.status === "timed-out") {
    throw new Error(
      `${label}: escalated to the DevOps Agent but it did not finish within the wait limit. ` +
      `Conversation: ${outcome.devopsConversationId}. The conversation is still live — check it, then re-promote once resolved.`,
    );
  }
  if (outcome.status === "escalated") {
    let status;
    try {
      status = await git(["status", "--porcelain"], repoPath);
    } catch (e) {
      // A failed read here must NOT be silently treated as "clean" — that
      // would let an unverified escalation resolve as "ready" on nothing
      // more than a git command happening to fail.
      throw new Error(`${label}: could not verify ${repoPath} is clean after DevOps Agent escalation: ${e?.message || e}. Conversation: ${outcome.devopsConversationId}.`);
    }
    if (status && status.trim() !== "") {
      throw new Error(
        `${label}: the DevOps Agent's run finished, but ${repoPath} still has uncommitted/conflicted changes — ` +
        `resolution doesn't look complete. Conversation: ${outcome.devopsConversationId}.`,
      );
    }
    slog("info", "promote", `${label}: DevOps Agent escalation resolved and verified clean`, { branch: cand.branch, versionLabel: "base" });
    cand.state = "ready";
    cand.devopsConversationId = undefined;
  }
}
