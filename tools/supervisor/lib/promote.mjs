import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BASE_PORT, CANONICAL_DATA, REMOTE, REPO } from "./config.mjs";
import { git, mutate, meaningfulDirtyLines, GIT_IDENTITY, tagStamp, requireFeatureBranch } from "./gitutil.mjs";
import { coupledReposFor, commitCoupled, resolveCoupledConflicts, promoteCoupled, clearCoupledBranchScope } from "./coupled-repos.mjs";
import { buildAndStart, runBuild } from "./build.mjs";
import { regenApps, startBaseDevProc } from "./base.mjs";
import { startProc, stopProc, waitHealthy } from "./proc.mjs";
import { reconcileViaApi, requireReconciled } from "./reconcile-client.mjs";
import { pushPromotedBase } from "./push.mjs";
import { clearActiveFeatureBranch } from "./conversations.mjs";
import { state, previews } from "./state.mjs";
import { log, slog } from "./log.mjs";

/** True when `base` is an ancestor of `candidateCommit` — i.e. fast-forwarding
 *  `base` onto it is still valid. Re-checked immediately before every
 *  `merge --ff-only` below: the candidate's own rebase/build/health-gate (as
 *  a preview) takes real wall-clock time, and nothing blocks the base branch
 *  from moving during that window (another promote, or an out-of-band
 *  rebase/reset of the base checkout) — so the precondition established
 *  earlier in `promote()` can go stale by the time this runs. Failing fast
 *  here with a clear message beats letting `merge --ff-only` fail deep
 *  inside a sequence that may already have stopped the base server. */
async function isFastForwardable(repoPath, base, candidateCommit) {
  try {
    await git(["merge-base", "--is-ancestor", base, candidateCommit], repoPath);
    return true;
  } catch (e) {
    // The caller throws a clear "advanced past the built candidate" error on
    // `false` — but that message can't distinguish a genuine non-ancestor
    // from `is-ancestor` itself failing (a corrupt ref, an unreadable repo).
    // This is the only place that distinction is still visible.
    slog("warn", "promote", `is-ancestor(${base}, ${candidateCommit}) in ${repoPath} failed: ${e?.message || e}`);
    return false;
  }
}

// ---- Fix C: preview service-config data-loss warning --------------------
// promote() is code-only: after merging the candidate's CODE (and coupled
// repos) into base, the preview's data clone (cand.dataDir) is destroyed.
// Any service runtime config a user set in preview — an item's data/secret.json
// (API key) or data/config.json (settings) — lives in that clone and is
// disposable by design (ADR-c: base is canonical, preview data is not carried
// over). That is correct, but it was SILENT: a user who configured an API key
// in preview and promoted found it gone on base with no warning.
//
// This is a WARNING, never a data-carry: it does not copy anything into base.
// It only surfaces, in the promote response, which per-item service configs
// set in preview will be lost so the user re-configures them on base.
const DATA_LOSS_FILES = ["secret.json", "config.json"];
const DATA_LOSS_FILE_LABEL = { "secret.json": "API key", "config.json": "settings" };

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function hashFile(p) {
  const buf = await fs.readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Scan a preview's data clone for per-item service runtime config and report
 * any file that is present in the preview but divergent from base's canonical
 * data dir (absent on base, or different content). Pure — takes both dirs as
 * arguments, touches nothing else, so it is testable in isolation.
 *
 * Returns one entry per divergent item:
 *   { item, files: ["secret.json", ...], message }
 * or [] when nothing set in preview differs from base (nothing to warn about).
 */
export async function scanDataLossWarnings(candDataDir, baseDataDir) {
  const candConfigRoot = path.join(candDataDir, "system", "config");
  let items = [];
  try {
    items = await fs.readdir(candConfigRoot, { withFileTypes: true });
  } catch {
    return []; // no config root in the preview — nothing could have been set there
  }
  const warnings = [];
  for (const item of items) {
    if (!item.isDirectory()) continue;
    const itemData = path.join(candConfigRoot, item.name, "data");
    const divergent = [];
    for (const file of DATA_LOSS_FILES) {
      const candFile = path.join(itemData, file);
      if (!(await pathExists(candFile))) continue; // not set in preview
      const baseFile = path.join(baseDataDir, "system", "config", item.name, "data", file);
      if (!(await pathExists(baseFile))) { divergent.push(file); continue; }
      if ((await hashFile(candFile)) !== (await hashFile(baseFile))) divergent.push(file);
    }
    if (divergent.length) {
      const label = divergent.map((f) => DATA_LOSS_FILE_LABEL[f] || f).join(" + ");
      warnings.push({
        item: item.name,
        files: divergent,
        message: `Service config (${label}) for ${item.name} set in preview will NOT be promoted — re-configure it on base after promote.`,
      });
    }
  }
  return warnings;
}

/**
 * Advance base to `candidateCommit`. Base has exactly ONE home in every
 * mode — the live checkout at REPO (042-worktree-collision) — the modes
 * differ only in how, or whether, the Supervisor restarts what runs there:
 *  - "reused": base is the user's OWN external `next dev` process. The merge
 *    lands in REPO (which is what that server reads); the Supervisor cannot
 *    restart someone else's process, so it just reports whether a manual
 *    restart is needed.
 *  - "dev": the Supervisor owns a `next dev` process in REPO — restart it.
 *  - "prod": the Supervisor owns a production server in REPO — REPO's
 *    checkout just moved forward, and dev's hot-reload doesn't apply to
 *    `next start`, so this rebuilds (`npm run build`) before restarting.
 *
 * The base branch ref moves (merge --ff-only) BEFORE any restart, same as
 * "dev"/"reused" always did. For "prod" this means a rebuild or health-check
 * failure leaves base down until it's fixed — deliberately: Promote is
 * gated on the candidate already having run as a live, human-verified
 * preview, so this is redeploying proven code, not a blind attempt. The
 * previous design avoided that downtime by adopting the candidate's OWN
 * preview worktree as base's identity instead of ever touching REPO — which
 * is exactly what let a later begin/build/discard for that same branch name
 * legitimately tear down the directory base was still running from. REPO is
 * never a path any preview lifecycle op computes or touches, so there is
 * nothing left to collide with.
 */
async function deployToBase(mode, candidateCommit, branch, warnings) {
  const tag = `bos/v${tagStamp()}`;
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
  // `changed = null` (rather than "") on a diff failure specifically means
  // "unknown" — deps/config below then default to true rather than false, so
  // a diff failure can only ever cause an UNNECESSARY npm install, never a
  // silently SKIPPED one for a base that genuinely needs it.
  let changed = prevBaseCommit ? "" : null;
  if (prevBaseCommit) {
    try {
      changed = await git(["diff", "--name-only", `${prevBaseCommit}..${candidateCommit}`], REPO);
    } catch (e) {
      slog("warn", "promote", `diff ${prevBaseCommit}..${candidateCommit} failed — assuming deps/config changed to be safe: ${e?.message || e}`, { branch });
      changed = null;
    }
  }
  const depsChanged = changed === null || /(^|\n)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)/.test(changed);
  const configChanged = changed === null || /(^|\n)(next\.config\.|tsconfig|\.env)/.test(changed);

  if (mode === "reused") {
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

  // Supervisor-owned base (dev or prod): install deps first if they changed,
  // then restart in REPO.
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

  if (mode === "dev") {
    startBaseDevProc(state.base);
  } else {
    // "prod": REPO's checkout just moved forward — `next start` needs a
    // fresh production build (dev's hot-reload doesn't apply here). A
    // failure means base is DOWN until it's fixed (see the doc comment
    // above) — logged loudly, never silently swallowed.
    const build = await runBuild(REPO, state.baseBranch);
    state.base.buildLog = build.relPath;
    if (!build.ok) {
      state.base.state = "failed";
      state.base.buildError = build.reason;
      slog("error", "promote", `base rebuild FAILED after merging ${branch} (exit ${build.code}) — base is DOWN`, { branch: state.baseBranch, versionLabel: "base", buildLog: build.relPath, err: { message: build.reason } });
      throw new Error(`promote failed: base rebuild failed after merging ${branch} onto ${state.baseBranch} — the merge already landed and base is DOWN; fix the build and retry:\n${build.reason}`);
    }
    startProc(state.base);
  }

  state.base.state = (await waitHealthy(BASE_PORT, state.base)) ? "ready" : "failed";
  if (state.base.state !== "ready") {
    throw new Error(`promote failed: base did not become healthy on :${BASE_PORT} after merging ${branch} — the merge already landed and base is DOWN; check the logs and retry.`);
  }
  log(`promoted ${branch} → base (tag ${tag}); base restarted${depsChanged ? " after npm install" : ""}`);
  return { tag, pushResults, needsRestart: false, worktree: REPO, mode };
}

// Promote the preview to BASE. Everything up through the candidate's own
// rebase/build/health-gate (as a PREVIEW, on its own port) happens first,
// while base still serves — a failure there leaves the base branch
// untouched. Once that's proven, deployToBase merges it into base's own
// checkout (REPO) and, for a Supervisor-owned base, stops/rebuilds/restarts
// it there: base has exactly one home, so unlike the old worktree-swap
// design there is no "build elsewhere, cut over instantly" option — a
// rebuild or health-check failure on REPO leaves base down until it's
// fixed. See deployToBase's own doc comment for why that trade is
// deliberate. The caller (Settings → Versions / the top-bar Active ▾ menu)
// requires the user to already be actively previewing the candidate before
// this can be invoked at all, so it is never a blind attempt.
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
  // Fix C: per-item service-config data-loss warnings (structured) computed
  // just before the preview's data clone is destroyed. Surfaced in the response
  // AND folded into `warnings` via promoteIssues on the client.
  let dataLossWarnings = [];
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
  const repos = await coupledReposFor(cand.worktree, cand.dataDir, cand.branch);
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
    try {
      await commitCoupled(repo, repo.dst, cand.branch);
    } catch (e) {
      // MUST abort, not warn-and-continue: promoteCoupled (later, after the
      // code promote's point of no return) tears down this exact worktree
      // with `git worktree remove --force`, which silently discards
      // whatever isn't committed. A failed commit here left something
      // uncommitted — proceeding would promote a stale version of this repo
      // and then destroy the real one. Nothing irreversible has happened
      // yet at this point, so failing here is still safe.
      throw new Error(`promote blocked — could not commit pending ${repo.id} changes in ${repo.dst}: ${e?.message || e}. Nothing was promoted; fix the issue and retry.`);
    }
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
  } catch (e) {
    // Treated as "not a descendant" (triggers the rebase path below) — the
    // safe default when this can't be confirmed either way; still worth
    // knowing it was the check itself failing, not a genuine divergence.
    slog("warn", "promote", `is-ancestor(${state.baseBranch}, HEAD) in ${cand.worktree} failed: ${e?.message || e}`, { branch: cand.branch });
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

  const mode = state.base?.dev ? "dev" : state.base?.reused ? "reused" : "prod";
  const deploy = await deployToBase(mode, newCommit, cand.branch, warnings);

  // Deregister the preview NOW, the instant base has actually adopted the
  // new code — not after the teardown steps below, which is where it used
  // to live. Those steps (stopProc, promoteCoupled, worktree/data-clone
  // removal) can take a real, non-trivial amount of time, and cand.worktree
  // stops existing on disk partway through them (the `git worktree remove`
  // mutate() call below). A concurrent /__supervisor/state poll that still
  // found this preview in the map during that window (liveBranch() reading
  // cand.worktree) would hit exactly that gone-directory race — a harmless
  // but alarming "not a git repository"/"spawn git ENOENT" warning. Once
  // deployToBase has succeeded there is no path back to using this preview
  // again regardless of how the best-effort cleanup below goes, so nothing
  // after this point needs it to still be registered.
  previews.delete(cand.branch);

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

  // Base never adopts the candidate's worktree — it always runs from REPO
  // (see deployToBase) — so the preview's worktree, data clone, and branch
  // are always fully disposable once promoted, in every mode.
  await mutate(`remove preview worktree ${cand.worktree}`, () => git(["worktree", "remove", "--force", cand.worktree]), warnings);
  // Fix C: the data clone is destroyed next. Warn about any per-item service
  // config (API key / settings) set in preview that will not survive. A scan
  // failure must NOT block the promote, but it must be loud — silently
  // swallowing it would reintroduce the exact data-loss blindness being fixed.
  dataLossWarnings = await scanDataLossWarnings(cand.dataDir, CANONICAL_DATA).catch((e) => {
    const msg = `data-loss warning scan failed: ${e?.message || e}`;
    slog("warn", "promote", msg, { branch: cand.branch });
    warnings.push(msg);
    return [];
  });
  await mutate(`remove data clone ${cand.dataDir}`, () => fs.rm(cand.dataDir, { recursive: true, force: true }), warnings);
  await mutate(`delete merged branch ${cand.branch}`, () => git(["branch", "-D", cand.branch]), warnings);
  // Any conversation still pointing at this now-deleted branch must be reset
  // to base — otherwise the next thing that resolves its active branch
  // (a dev-harness call, an app install, …) recreates one of the same name,
  // which looks like "the branch came back" and, before REPO became base's
  // only home, could land the new preview on a path base itself still used.
  await clearActiveFeatureBranch(cand.branch, warnings);
  // The scope outlived the branch: nothing cleared it, so every branch ever
  // created kept an entry and a REUSED name silently inherited the old scope.
  await clearCoupledBranchScope(cand.branch, warnings);

  return { tag: deploy.tag, branch: cand.branch, pushResults: deploy.pushResults, needsRestart: deploy.needsRestart, message: deploy.message, dev: deploy.mode === "dev", reused: deploy.mode === "reused", warnings, ...(dataLossWarnings.length ? { dataLossWarnings } : {}), ...(conflictSessionId ? { sessionId: conflictSessionId } : {}) };
}
