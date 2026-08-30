import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BASE_PORT, REMOTE, CANONICAL_DATA, REPO } from "./config.mjs";
import { git, mutate, meaningfulDirtyLines, GIT_IDENTITY, tagStamp, requireFeatureBranch } from "./gitutil.mjs";
import { coupledReposFor, commitCoupled, resolveCoupledConflicts, promoteCoupled } from "./coupled-repos.mjs";
import { buildAndStart } from "./build.mjs";
import { regenApps, startBaseDevProc } from "./base.mjs";
import { startProc, stopProc, waitHealthy } from "./proc.mjs";
import { reconcileViaApi, requireReconciled } from "./reconcile-client.mjs";
import { pushPromotedBase } from "./push.mjs";
import { state, previews } from "./state.mjs";
import { log, slog } from "./log.mjs";

/** True when `base` is an ancestor of `candidateCommit` — i.e. fast-forwarding
 *  `base` onto it is still valid. Re-checked immediately before every
 *  `merge --ff-only` below: a swap-mode build + health-gate takes real
 *  wall-clock time, and nothing blocks the base branch from moving during
 *  that window (another promote, or an out-of-band rebase/reset of the base
 *  checkout) — so the precondition established earlier in `promote()` can go
 *  stale by the time this runs. Failing fast here with a clear message beats
 *  letting `merge --ff-only` fail deep inside a sequence that may have
 *  already stopped the old base server. */
async function isFastForwardable(repoPath, base, candidateCommit) {
  try {
    await git(["merge-base", "--is-ancestor", base, candidateCommit], repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Advance base to `candidateCommit`. The three modes only genuinely differ
 * in WHEN the base branch ref moves relative to health verification:
 *  - "dev"/"reused": base IS the live checkout (REPO) — moving the ref onto
 *    the built worktree's tip *is* the deploy step (the checkout/worktree
 *    that already reads REPO picks it up on restart, or on next dev's own
 *    hot-reload for a reused external server).
 *  - "swap": base is a swappable worktree/process — a fresh worktree must be
 *    built and health-gated ON THE BASE PORT *before* the ref moves (the
 *    "point of no return"), since a bad promote must leave the OLD base
 *    running, undisturbed, if the new one never becomes healthy.
 *
 * Returns `{ tag, pushResults, needsRestart, message?, worktree, mode }` —
 * `worktree` is where the promoted code now lives (for the dev/reused
 * modes this is unchanged from REPO; for swap it's the candidate's own
 * worktree, now adopted as base's).
 */
async function deployToBase(mode, candidateCommit, candidateWorktree, branch, warnings) {
  const tag = `bos/v${tagStamp()}`;

  if (mode === "dev" || mode === "reused") {
    const prevBaseCommit = state.base.commit;
    await git(["checkout", state.baseBranch], REPO);
    if (!(await isFastForwardable(REPO, state.baseBranch, candidateCommit))) {
      throw new Error(`promote failed: ${state.baseBranch} advanced past the built candidate for ${branch} (${candidateCommit}) while promoting; retry the promote so it reconciles against the current base.`);
    }
    await git(["merge", "--ff-only", candidateCommit], REPO);
    await git([...GIT_IDENTITY, "tag", "-a", tag, "-m", `promote ${branch}`], REPO);
    const pushResults = await pushPromotedBase(REPO, state.baseBranch);
    state.base.commit = candidateCommit;
    // Regenerate the built-in app registry so a merged built-in app (its
    // generated manifest is gitignored, thus not in the merge) is actually
    // registered on base.
    await regenApps(warnings);
    let changed = "";
    if (prevBaseCommit) {
      try { changed = await git(["diff", "--name-only", `${prevBaseCommit}..${candidateCommit}`], REPO); } catch { changed = ""; }
    }
    const depsChanged = /(^|\n)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)/.test(changed);
    const configChanged = /(^|\n)(next\.config\.|tsconfig|\.env)/.test(changed);

    if (mode === "dev") {
      // Supervisor owns the base dev server → make the promote deterministic:
      // install deps when they changed, then restart base so the merged
      // code is definitely live.
      if (depsChanged) {
        slog("info", "promote", `installing dependencies after promote (${state.baseBranch})`, { branch: state.baseBranch, versionLabel: "base" });
        await promisify(execFile)("npm", ["install"], { cwd: REPO, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }).catch((e) => {
          const msg = `npm install failed: ${e?.message || e}`;
          slog("warn", "promote", msg, { branch: state.baseBranch, versionLabel: "base" });
          warnings.push(msg);
        });
      }
      await stopProc(state.base);
      state.base.state = "building";
      startBaseDevProc(state.base);
      state.base.state = (await waitHealthy(BASE_PORT, state.base)) ? "ready" : "failed";
      log(`promoted ${branch} → base (owned dev, tag ${tag}); base restarted${depsChanged ? " after npm install" : ""}`);
      return { tag, pushResults, needsRestart: false, worktree: REPO, mode };
    }

    // Reused external server: the Supervisor can't restart it. next dev
    // hot-reloads code edits; deps/config changes need the user to restart
    // their dev server.
    const needsRestart = depsChanged || configChanged;
    log(`promoted ${branch} → base via live checkout (reused, tag ${tag})${needsRestart ? " — DEV SERVER RESTART REQUIRED (deps/config changed)" : ""}`);
    return {
      tag,
      pushResults,
      needsRestart,
      worktree: REPO,
      mode,
      ...(needsRestart ? { message: "Dependencies or config changed. Restart your dev server (and run npm install) so base picks up the promoted code." } : {}),
    };
  }

  // swap: stop old base (await exit), start the candidate's code on
  // BASE_PORT against CANONICAL data, health-gate THERE — all BEFORE
  // touching the base branch ref (the point of no return below).
  const oldBase = state.base;
  await stopProc(oldBase);
  const swapped = { role: "base", branch, worktree: candidateWorktree, dataDir: CANONICAL_DATA, port: BASE_PORT, state: "building", proc: null, commit: candidateCommit };
  startProc(swapped);

  // Old base is stopped from this point on — ANY failure below must restore
  // it before throwing, or `state.base` is left referencing a dead process
  // while this healthy-but-unpromoted server keeps running unmanaged on the
  // base port (observed in production: state.base reported "stopped" while
  // the base port kept serving 200s from an orphaned swap attempt).
  const restoreOldBase = async () => {
    await stopProc(swapped);
    if (oldBase) {
      startProc(oldBase);
      // Must set .state from the result, not just await it: `stopProc`
      // above left `swapped` mid-"building", and wireExitHandler marks ANY
      // exit of a "building" version "failed" regardless of whether it was
      // deliberate — leaving state.base permanently misreporting a healthy
      // restart as failed (this is exactly what happened to `oldBase`
      // itself the first time IT was swapped in, further down).
      oldBase.state = (await waitHealthy(oldBase.port, oldBase)) ? "ready" : "failed";
      state.base = oldBase;
    }
  };

  if (!(await waitHealthy(BASE_PORT, swapped))) {
    // Failure AFTER killing old base but BEFORE moving the base ref → restore old base.
    await restoreOldBase();
    throw new Error(`promote failed: ${branch} did not become healthy on the base port; restored the previous base. The base branch was NOT moved.`);
  }
  // The health-gate just passed — reflect that. Without this, `swapped`
  // stays at its initial "building" forever (even after being adopted as
  // base below), so the NEXT promote's `stopProc` of it trips the
  // "building"-exit-means-failed branch in wireExitHandler and misreports a
  // healthy base as failed.
  swapped.state = "ready";

  // Point of no return: fast-forward the base branch to the candidate, tag, push.
  await git(["checkout", state.baseBranch], REPO);
  if (!(await isFastForwardable(REPO, state.baseBranch, candidateCommit))) {
    await restoreOldBase();
    throw new Error(`promote failed: ${state.baseBranch} advanced past the built candidate for ${branch} (${candidateCommit}) while it was building; restored the previous base. The base branch was NOT moved — retry the promote so it reconciles against the current base.`);
  }
  try {
    await git(["merge", "--ff-only", candidateCommit], REPO);
  } catch (e) {
    await restoreOldBase();
    throw new Error(`promote failed: could not fast-forward ${state.baseBranch} to ${branch} (${candidateCommit}); restored the previous base. The base branch was NOT moved. (${e?.message || e})`);
  }
  await git([...GIT_IDENTITY, "tag", "-a", tag, "-m", `promote ${branch}`], REPO);
  const pushResults = await pushPromotedBase(REPO, state.baseBranch);

  // Adopt the swapped server as base. Detach its worktree off the feature
  // branch (same commit → no file change, server keeps running) so the
  // now-merged branch can be deleted and base isn't sitting "on" a feature
  // branch.
  state.base = swapped;
  await mutate("detach adopted base worktree", () => git(["checkout", "--detach"], swapped.worktree), warnings);
  state.base.branch = state.baseBranch;
  if (oldBase?.worktree && oldBase.worktree !== swapped.worktree) {
    await mutate(`remove old base worktree ${oldBase.worktree}`, () => git(["worktree", "remove", "--force", oldBase.worktree]), warnings);
  }
  log(`promoted ${branch} → base (tag ${tag})`);
  return { tag, pushResults, needsRestart: false, worktree: swapped.worktree, mode };
}

// Promote the preview to BASE. Safe ordering: do every fallible step
// (rebase, build, off-port health-gate) while base still serves; only AFTER
// the new code is healthy on the base port do we advance the base branch
// ref + tag (the point of no return). A failure before that leaves the base
// branch untouched and restores the old base.
export async function promote(branch) {
  const cand = previews.get(requireFeatureBranch(branch, state.baseBranch));
  if (!cand) throw new Error(`no preview to promote for ${branch}`);
  if (cand.state === "stopped" || cand.state === "not-built") {
    const st = await buildAndStart(cand);
    if (st !== "ready") throw new Error(`preview ${cand.branch} is not ready (state: ${st}).`);
  }
  if (cand.state !== "ready") throw new Error(`preview ${cand.branch} is not ready (state: ${cand.state}).`);

  // A failed status check must abort the promote, not be silently read as
  // "clean" — a plain throwing git() call does that naturally.
  const dirty = await git(["status", "--porcelain"], REPO);
  const meaningfulDirty = meaningfulDirtyLines(dirty);
  if (meaningfulDirty.length > 0) {
    throw new Error(`base checkout (${REPO}) has uncommitted changes — commit, stash, or discard them before promoting:\n${meaningfulDirty.join("\n")}`);
  }
  const warnings = [];
  // 035 (FR-018): whichever step escalated, the promote response carries the
  // resolution session id so the UI can link straight into the conflict pane.
  let conflictSessionId;
  if (dirty) {
    // Only package-lock.json drift from a previous promote's npm install is
    // present — discard it so the upcoming fast-forward merge below isn't
    // blocked by a tracked-file conflict.
    await mutate("discard package-lock.json drift", () => git(["checkout", "--", "package-lock.json"], REPO), warnings);
  }

  // 020: coupled-repo work (specs + user-apps) promotes WITH the code.
  // Commit any pending worktree edits, then pre-check every merge — a
  // conflict in ANY coupled repo must fail the promote before anything
  // irreversible happens.
  const repos = await coupledReposFor(cand.worktree, cand.dataDir);
  // 035 (FR-012a / the reported bug): a coupled-repo conflict no longer throws
  // `promote blocked — …` with no agent. It is handed to the shared pipeline,
  // which creates a resolution session, emits the auto-launch event, and runs
  // the conflict-resolution agent against THAT repo. Nothing irreversible has
  // happened at this point, so if the resolution genuinely fails the promote
  // still stops here — now with a session id and a rollback tag (FR-018).
  const onCoupledEscalate = (devopsConversationId, sessionId) => {
    cand.state = "escalated";
    cand.devopsConversationId = devopsConversationId;
    cand.conflictSessionId = sessionId;
  };
  for (const repo of repos) {
    await commitCoupled(repo, repo.dst, cand.branch).catch((e) => slog("warn", "promote", `${repo.id}: commit failed: ${e?.message || e}`, { branch: cand.branch }));
    const resolved = await resolveCoupledConflicts(repo, cand.branch, onCoupledEscalate);
    if (resolved.sessionId) conflictSessionId = resolved.sessionId;
    if (!resolved.ok) {
      const err = new Error(`promote blocked — ${resolved.message}`);
      err.sessionId = resolved.sessionId;
      err.devopsConversationId = resolved.conversationId;
      throw err;
    }
    if (cand.state === "escalated") {
      // Resolved: clear the interim indicator so the promote continues in a
      // clean state (mirrors requireReconciled's own contract).
      cand.state = "ready";
      cand.devopsConversationId = undefined;
    }
  }

  // 1) Sync base with origin FIRST (001-external-repo-integration, US6): the
  // same shared reconciliation pipeline used for every GitFS instance (tag,
  // sync, strategy, scripted rebase fallback, DevOps Agent escalation) —
  // reduces the odds that the later push is rejected because base silently
  // drifted from origin between promotes (e.g. another environment pushed
  // independently).
  slog("info", "promote", `syncing base (${state.baseBranch}) with ${REMOTE} before merging ${cand.branch}`, { branch: state.baseBranch, versionLabel: "base" });
  const baseSync = await reconcileViaApi(
    {
      repoPath: REPO,
      remote: REMOTE,
      branch: state.baseBranch,
      sourceRef: `${REMOTE}/${state.baseBranch}`,
      strategy: "merge-squash",
      escalationContext: `Supervisor promote: syncing base branch "${state.baseBranch}" with "${REMOTE}" before merging feature branch "${cand.branch}" onto it.`,
    },
    (devopsConversationId, sessionId) => {
      cand.state = "escalated";
      cand.devopsConversationId = devopsConversationId;
      cand.conflictSessionId = sessionId;
      conflictSessionId = sessionId;
    },
  );
  if (baseSync.sessionId) conflictSessionId = baseSync.sessionId;
  await requireReconciled(cand, baseSync, REPO, `syncing base (${state.baseBranch}) with ${REMOTE}`);
  if (baseSync.warnings?.length) warnings.push(...baseSync.warnings);
  slog("info", "promote", `base (${state.baseBranch}) synced with ${REMOTE}${baseSync.method ? ` via ${baseSync.method}` : " (already up to date)"}`, { branch: state.baseBranch, versionLabel: "base" });

  // 2) Make the preview a clean descendant of the now-synced base, in its
  // own worktree. FF: already ahead → nothing to do. Otherwise: squash-merge
  // the candidate's changes onto base via the same shared pipeline.
  let candIsDescendant = true;
  try {
    await git(["merge-base", "--is-ancestor", state.baseBranch, "HEAD"], cand.worktree);
  } catch {
    candIsDescendant = false;
  }
  if (!candIsDescendant) {
    cand.state = "building";
    await stopProc(cand);
    const originalCandTip = await git(["rev-parse", "HEAD"], cand.worktree);
    await git(["reset", "--hard", state.baseBranch], cand.worktree);
    slog("info", "promote", `merging ${cand.branch} (${originalCandTip}) onto ${state.baseBranch}`, { branch: cand.branch, versionLabel: "base" });
    const merge = await reconcileViaApi(
      {
        repoPath: cand.worktree,
        sourceRef: originalCandTip,
        strategy: "merge-squash",
        featureBranchForDelegate: cand.branch,
        escalationContext: `Supervisor promote: merging feature branch "${cand.branch}" (original tip ${originalCandTip}) onto base "${state.baseBranch}".`,
      },
      (devopsConversationId, sessionId) => {
        cand.state = "escalated";
        cand.devopsConversationId = devopsConversationId;
        cand.conflictSessionId = sessionId;
        conflictSessionId = sessionId;
      },
    );
    if (merge.sessionId) conflictSessionId = merge.sessionId;
    await requireReconciled(cand, merge, cand.worktree, `merging ${cand.branch} onto ${state.baseBranch}`);
    if (merge.warnings?.length) warnings.push(...merge.warnings);
    slog("info", "promote", `${cand.branch} merged onto ${state.baseBranch}${merge.method ? ` via ${merge.method}` : ""}`, { branch: cand.branch, versionLabel: "base" });

    cand.state = "building";
    const st = await buildAndStart(cand);
    if (st !== "ready") throw new Error(`rebuilt preview ${cand.branch} failed its health check (state: ${st}); base unchanged.`);
  }
  const newCommit = await git(["rev-parse", "HEAD"], cand.worktree);

  const mode = state.base?.dev ? "dev" : state.base?.reused ? "reused" : "swap";
  const deploy = await deployToBase(mode, newCommit, cand.worktree, cand.branch, warnings);

  // Land the coupled repos now that the code promote is committed, BEFORE
  // the preview's worktree/data clone (which is what each coupled worktree
  // physically lives inside) is torn down below. Any merge failure here is
  // recorded into `warnings`, not silently dropped — the whole point of
  // this refactor.
  await stopProc(cand); // the preview's pool-port server is now redundant — reap it so it doesn't leak
  for (const repo of repos) {
    await promoteCoupled(repo, cand.branch, repo.dst, warnings, onCoupledEscalate);
    if (cand.conflictSessionId) conflictSessionId = cand.conflictSessionId;
  }

  // Reap the promoted preview. In "swap" mode cand.worktree WAS adopted as
  // base's own worktree (deploy.worktree === cand.worktree) — it must be
  // kept, not removed; only the previous base's now-unused worktree was
  // already cleaned up inside deployToBase.
  if (deploy.mode !== "swap") {
    await mutate(`remove preview worktree ${cand.worktree}`, () => git(["worktree", "remove", "--force", cand.worktree]), warnings);
  }
  await fs.rm(cand.dataDir, { recursive: true, force: true }).catch((e) => warnings.push(`remove data clone ${cand.dataDir} failed: ${e?.message || e}`));
  await mutate(`delete merged branch ${cand.branch}`, () => git(["branch", "-D", cand.branch]), warnings);
  previews.delete(cand.branch);

  // The adopted base worktree stays right where it was built — under the
  // now-deleted feature branch's own directory (deploy.worktree) — rather
  // than being relocated to a canonical WORKTREES/base path. That relocation
  // was tried once (`git worktree move`) and pulled the directory out from
  // under state.base's ALREADY-LIVE `next start` process: its CWD survives a
  // rename, but Next.js lazily requires route-specific modules on demand
  // (e.g. cookie parsing, only pulled in when a request needs it), and any
  // such require firing after the rename resolves against the OLD absolute
  // path baked into its already-loaded parent module — which no longer
  // exists — and crashes with MODULE_NOT_FOUND. The rename bought nothing
  // functional: `state.base.worktree` is read live everywhere (proc.mjs,
  // build.mjs, preview.mjs, the next promote's own "remove old base
  // worktree" step below) rather than assumed to be canonical, and
  // supervisor.mjs's reconcileWorktrees()+addBaseWorktree() wipe and rebuild
  // this worktree from scratch at the canonical path on every restart
  // anyway — so the only thing a mid-lifetime rename bought was tidier `ls`
  // output, not worth risking the live server for.

  return { tag: deploy.tag, branch: cand.branch, pushResults: deploy.pushResults, needsRestart: deploy.needsRestart, message: deploy.message, dev: deploy.mode === "dev", reused: deploy.mode === "reused", warnings, ...(conflictSessionId ? { sessionId: conflictSessionId } : {}) };
}
