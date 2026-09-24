import { spawn } from "node:child_process";
import { HEALTH_TIMEOUT_MS, BUILD_TIMEOUT_MS } from "./config.mjs";
import { git, GIT_IDENTITY } from "./gitutil.mjs";
import { mountedSpecStoresIn, commitCoupled } from "./coupled-repos.mjs";
import { assertRepoIntegrity } from "./worktree.mjs";
import { startProc, waitHealthy, stopProc } from "./proc.mjs";
import { slog, getLogStore } from "./log.mjs";

// Run `npm run build` in a worktree, STREAMING stdout+stderr into a
// build-log blob and keeping a tail as the failure reason. This is the fix
// for the "build failed and I couldn't see why" black box (specs/017): the
// real compiler output is now persisted and the reason is surfaced.
// Resolves { ok, code, reason, relPath }.
export function runBuild(cwd, branch) {
  return new Promise((resolve) => {
    const blob = getLogStore().openBuildLog(branch);
    let child;
    try {
      child = spawn("npm", ["run", "build"], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      blob.stream.end();
      resolve({ ok: false, code: null, reason: `failed to spawn build: ${e.message}`, relPath: blob.relPath });
      return;
    }
    const TAIL_MAX = 16 * 1024;
    let tail = "";
    let droppedLogBytes = 0;
    const onChunk = (c) => {
      try {
        blob.stream.write(c);
      } catch (e) {
        // The build's own log blob failing to write must not fail the
        // build — but it also must not vanish silently: count it so a
        // persistently-broken build-log sink is visible in the eventual
        // result, since the tail-based failure reason (used below) is the
        // only diagnostic surfaced to the caller if the full log is lossy.
        droppedLogBytes += c.length;
        if (droppedLogBytes === c.length) slog("warn", "build", `build log write failed for ${branch}, continuing without a full log: ${e?.message || e}`, { branch });
      }
      tail += c.toString();
      if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    const killer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, BUILD_TIMEOUT_MS);
    const done = (r) => { clearTimeout(killer); blob.stream.end(); resolve(r); };
    child.on("error", (e) => done({ ok: false, code: null, reason: `failed to spawn build: ${e.message}`, relPath: blob.relPath }));
    child.on("close", (code) => {
      const reason = code === 0 ? "" : (tail.trim().split("\n").slice(-40).join("\n") || `build exited with code ${code}`);
      done({ ok: code === 0, code, reason, relPath: blob.relPath });
    });
  });
}

// Build a preview worktree (commit its edits onto the feature branch so a
// later promote can fast-forward them), (re)start it, and health-gate it.
// Stops any existing server for this version FIRST so a rebuild never
// collides on its port. On failure it sets state "failed" + stashes the
// reason (v.buildError) rather than throwing, so callers (e.g. /build) can
// surface WHY.
export async function buildAndStart(v, ctx = {}) {
  await stopProc(v);
  // Commit spec-store worktrees FIRST (020): spec work belongs on the
  // store's refs (visible from base, teardown-safe) the moment the
  // candidate builds. User-apps content is committed by installItem() as it
  // writes, plus a safety-net commit at promote time (see lib/promote.mjs)
  // — not duplicated here, matching the pre-refactor behavior.
  //
  // Read from DISK, not from the branch's scope: this commits what is mounted,
  // and committing is not what creates a branch (mountCoupled is). Asking for a
  // scoped list here would make the commit set disagree with the mount set for
  // any branch mounted under an older scope, and would log a scope decision for
  // the base branch, which mounts nothing at all.
  for (const repo of await mountedSpecStoresIn(v.worktree)) {
    await commitCoupled(repo, repo.dst, v.branch).catch((e) =>
      slog("warn", "build", `${repo.id}: commit failed for ${v.branch}: ${e?.message || e}`, { branch: v.branch, versionLabel: v.role }),
    );
  }
  try {
    await git(["add", "-A"], v.worktree);
  } catch (e) {
    // A failed `git add` here is exactly the failure mode this whole commit
    // step exists to prevent going unnoticed: the immediately-following
    // `git commit` would find nothing staged and hit the harmless "nothing
    // to commit" branch below, silently reporting a candidate as clean when
    // its edits were never durably committed at all. Must abort, not warn
    // and continue on a stale commit.
    v.state = "failed";
    v.buildError = `failed to stage candidate changes in ${v.worktree}: ${e?.message || e}`;
    slog("error", "build", `build BLOCKED: ${v.branch} — git add failed`, { branch: v.branch, versionLabel: v.role, err: { message: v.buildError } });
    return v.state;
  }
  try {
    await git([...GIT_IDENTITY, "commit", "-m", `BOS candidate (${v.branch})`], v.worktree);
  } catch (e) {
    const detail = String(e?.stderr || e?.stdout || e?.message || e || "");
    if (detail && !/nothing to commit|no changes added/.test(detail)) {
      // A real commit failure (not just "nothing to commit") means the
      // worktree's edits are NOT durably on the branch — building/promoting
      // from here would silently work with a stale commit. That must abort
      // the build, not just warn and continue on whatever v.commit was
      // before.
      v.state = "failed";
      v.buildError = `failed to commit candidate changes in ${v.worktree}: ${detail}`;
      slog("error", "build", `build BLOCKED: ${v.branch} — commit failed`, { branch: v.branch, versionLabel: v.role, err: { message: v.buildError } });
      return v.state;
    }
  }
  try {
    v.commit = await git(["rev-parse", "HEAD"], v.worktree);
  } catch (e) {
    v.state = "failed";
    v.buildError = `failed to read HEAD in ${v.worktree}: ${e?.message || e}`;
    slog("error", "build", `build BLOCKED: ${v.branch} — cannot read commit`, { branch: v.branch, versionLabel: v.role, err: { message: v.buildError } });
    return v.state;
  }
  // Safety gate: the worktree commit must never have leaked into the main checkout.
  const integrity = await assertRepoIntegrity(`build ${v.branch}`);
  if (integrity.touched) {
    v.state = "failed";
    v.buildError =
      "developer harness edited the live checkout instead of the isolated preview worktree; the live checkout was restored and this candidate was not built" +
      // Named, because the cause is usually a DIFFERENT run than this build:
      // a contentOnly delegation writing a relative path while standing in the
      // live checkout. Without the paths there is nothing to act on.
      (integrity.dirty ? `. Restored: ${integrity.dirty}` : "");
    slog("error", "build", `build BLOCKED: ${v.branch}`, { branch: v.branch, versionLabel: v.role, err: { message: v.buildError } });
    return v.state;
  }
  v.state = "building";
  v.buildError = "";
  const lctx = { branch: v.branch, versionLabel: v.role, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) };
  slog("info", "build", `building ${v.branch} @ ${v.worktree} (commit ${String(v.commit).slice(0, 8)})`, lctx);
  const build = await runBuild(v.worktree, v.branch, lctx);
  v.buildLog = build.relPath;
  if (!build.ok) {
    v.state = "failed";
    v.buildError = build.reason;
    slog("error", "build", `build FAILED: ${v.branch} (exit ${build.code})`, { ...lctx, buildLog: build.relPath, err: { message: build.reason } });
    return v.state;
  }
  startProc(v);
  v.state = (await waitHealthy(v.port, v)) ? "ready" : "failed";
  // Only when nothing more specific was recorded. wireExitHandler already
  // writes the real reason when the process DIES during the wait ("preview
  // process exited before becoming healthy (exited with code 0)") — and this
  // line used to overwrite it unconditionally, so a preview that died 0.7s
  // after becoming ready was reported as a 120-second health-check timeout.
  // The user reads this string; it has to be what happened.
  if (v.state === "failed" && !v.buildError) {
    v.buildError = `health check failed: no healthy /api/health on :${v.port} within ${HEALTH_TIMEOUT_MS}ms`;
  }
  slog(v.state === "ready" ? "info" : "error", "build", `${v.branch} -> ${v.state}`, { ...lctx, buildLog: build.relPath, ...(v.buildError ? { err: { message: v.buildError } } : {}) });
  return v.state;
}
