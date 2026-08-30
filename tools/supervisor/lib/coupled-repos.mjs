import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SPECS_ROOT, APPS_REPO } from "./config.mjs";
import { git, refExists, mutate, GIT_IDENTITY } from "./gitutil.mjs";
import { reconcileViaApi } from "./reconcile-client.mjs";
import { slog } from "./log.mjs";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// CoupledRepo abstraction (020-branch-coupled-specs, retrofitted onto
// user-apps). One feature = one branch name across the BOS repo AND every
// coupled repo (each spec store, plus user-apps). A coupled repo is mounted
// into a preview as a GIT WORKTREE checked out on the feature branch;
// promote merges every one of them (code + every coupled repo) as a single
// logical operation, discard drops every one of them. This replaces the
// previously hand-duplicated spec-store pair (mountSpecStores/
// commitSpecStores/specStoreConflicts/promoteSpecStores/discardSpecStores)
// and user-apps pair (mountUserApps/commitUserApps/userAppsConflicts/
// promoteUserApps/discardUserApps) with ONE implementation, parameterized by
// repo — one place to get merge/cleanup error-handling right instead of two
// hand-copied near-duplicates that could (and did) silently drift apart.
//
// @typedef {{id:string, root:string, kind:"spec-store"|"user-apps"}} CoupledRepo

async function symbolicRefOrNull(root) {
  try {
    return await git(["symbolic-ref", "--short", "HEAD"], root);
  } catch {
    // Detached HEAD (symbolic-ref has nothing to report) — a documented,
    // expected condition, not a failure worth recording; callers treat "no
    // symbolic ref" as "primary checkout is busy/unavailable for a direct
    // merge" and fall back to the plumbing-merge path below.
    return null;
  }
}

/** Where a direct merge for this repo would land, and whether the primary
 *  checkout is busy — in which case merging must go through git plumbing
 *  instead of touching the working tree.
 *
 *  Every coupled repo (spec stores AND user-apps) now has exactly ONE branch
 *  scheme over it: the feature-branch coupling this module implements. The
 *  old app-candidate mechanism used to check user-apps out onto a second,
 *  in-place branch, which needed a `liveCheckoutOwners` registry here so a
 *  concurrent promote wouldn't flip branches on the directory BASE was
 *  live-serving from. With that mechanism retired there is no second owner
 *  to coordinate with, so "busy" reduces to the one genuine case: a detached
 *  HEAD, where there is no branch to merge into directly. */
async function coupledMergeTarget(repo) {
  const cur = await symbolicRefOrNull(repo.root);
  const busy = !cur;
  return { busy, base: busy ? "master" : cur };
}

// A store = a subdirectory of SPECS_ROOT with its own `.git` and a manifest
// (same discovery rule as src/lib/specs/stores.ts — never the container
// itself).
export async function listSpecStores() {
  let entries;
  try {
    entries = await fs.readdir(SPECS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const stores = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const root = path.join(SPECS_ROOT, e.name);
    try {
      await fs.access(path.join(root, ".git"));
      await fs.access(path.join(root, "spec-store.json"));
      stores.push({ id: e.name, root, kind: "spec-store" });
    } catch {
      /* not a store */
    }
  }
  return stores;
}

async function appsRepoExists() {
  try { await fs.access(path.join(APPS_REPO, ".git")); return true; } catch { return false; }
}

/** Idempotent: creates data/user-apps as its own git repo the first time
 *  anything needs it mounted. */
export async function ensureAppsRepo(warnings) {
  if (await appsRepoExists()) return;
  await fs.mkdir(APPS_REPO, { recursive: true });
  await git(["init", "-q"], APPS_REPO);
  // An init commit is the repo's documented invariant (every consumer assumes
  // at least one commit exists) — its failure must be visible, not a
  // silent-empty-repo footgun for whatever mounts it next.
  await mutate("user-apps: create init commit", () => git([...GIT_IDENTITY, "commit", "--allow-empty", "-q", "-m", "init content repo"], APPS_REPO), warnings);
}

/** Just the spec-store repos, with their preview-mount destination — used by
 *  build.mjs's buildAndStart, which (matching the pre-refactor behavior)
 *  commits spec-store edits at build time but leaves user-apps commits to
 *  its own write path (installItem()) plus the promote-time safety net. */
export async function specStoreReposFor(worktree) {
  return (await listSpecStores()).map((s) => ({ ...s, dst: path.join(worktree, "specs", s.id) }));
}

/** Every coupled repo a promote/discard for `branch` must touch: every spec
 *  store, plus user-apps. `dst` is where each is (or will be) mounted as a
 *  worktree for this branch's preview. */
export async function coupledReposFor(worktree, dataDir) {
  const specs = (await listSpecStores()).map((s) => ({ ...s, dst: path.join(worktree, "specs", s.id) }));
  return [...specs, { id: "user-apps", root: APPS_REPO, kind: "user-apps", dst: path.join(dataDir, "user-apps") }];
}

/** Mount (or refresh) `repo`'s worktree for `branch` at `dst`. Reuses an
 *  intact existing mount; otherwise prunes stale registrations and adds the
 *  worktree — on the existing branch, or a new one off the repo's current
 *  primary branch. */
export async function mountCoupled(repo, dst, branch) {
  if (repo.kind === "user-apps") await ensureAppsRepo();
  const mounted = await fs.access(path.join(dst, ".git")).then(() => true).catch(() => false);
  if (mounted) {
    let cur;
    try { cur = await git(["rev-parse", "--abbrev-ref", "HEAD"], dst); } catch { cur = null; }
    if (cur === branch) return;
  }
  await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await git(["worktree", "prune"], repo.root).catch(() => {}); // pruning stale registrations is inherently best-effort; the `worktree add` below still throws if it genuinely can't proceed
  if (await refExists(repo.root, `refs/heads/${branch}`)) {
    await git(["worktree", "add", dst, branch], repo.root);
  } else {
    const { base } = await coupledMergeTarget(repo);
    await git(["worktree", "add", "-b", branch, dst, base], repo.root);
  }
}

/** Commit pending edits in the mounted worktree (mirrors the code-worktree
 *  commit in build.mjs). Most callers already commit as they go (Build
 *  Studio, installItem) — this is the safety net, not the primary path, so
 *  it must not throw "nothing to commit" as if it were a real failure. */
export async function commitCoupled(repo, dst, branch) {
  if (!(await fs.access(path.join(dst, ".git")).then(() => true).catch(() => false))) return;
  await git(["add", "-A"], dst);
  const dirty = await git(["status", "--porcelain"], dst);
  if (!dirty) return;
  await git([...GIT_IDENTITY, "commit", "-m", `${repo.kind} candidate (${branch})`], dst);
}

/** Pre-check: can `branch` merge cleanly into `repo`'s current primary
 *  branch? Returns null when clean, else a description. Run BEFORE the code
 *  promote's point of no return so a coupled-repo conflict never strands a
 *  half-promoted feature. */
export async function coupledConflicts(repo, branch) {
  if (!(await refExists(repo.root, `refs/heads/${branch}`))) return null;
  const { base } = await coupledMergeTarget(repo);
  let mb;
  try { mb = await git(["merge-base", base, branch], repo.root); } catch { return null; }
  try {
    await exec("git", ["merge-tree", "--write-tree", `--merge-base=${mb}`, base, branch], { cwd: repo.root, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    const out = `${String(e.stdout || "")}\n${String(e.stderr || "")}`.trim();
    return `${repo.id}: branch ${branch} conflicts with ${base}:\n${out || "(merge conflicts)"}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 035-spec-promote-conflict-escalation (FR-012a / FR-015) — the reported bug's
// site. A coupled-repo conflict used to dead-end: the pre-check threw
// `promote blocked — …` and the merge fell back to `merge --abort` + a
// warning, with no agent anywhere. Both now route through the SHARED
// reconciliation pipeline over the Supervisor's existing loopback HTTP
// (/api/gitfs/reconcile) — the Supervisor never imports BOS `@/` source and
// never hard-codes a BOS path; everything repo-specific is passed as the
// working context, which is the one thing that varies per repo (FR-003/004).

/** The working context for a coupled repo. This is the ONLY per-repo
 *  variation in the whole mechanism: the conflict agent reads and writes
 *  through the same `conflict_*` tools regardless of which repo it is. */
function workContextFor(repo, base, busy) {
  return {
    repoKind: repo.kind === "user-apps" ? "user-apps" : "user-specs",
    repoRoot: repo.root,
    repoLabel: repo.kind === "user-apps" ? "user-apps" : `${repo.id} store`,
    // A busy (detached-HEAD) primary checkout means there is no tree to
    // merge in — resolutions are landed with commit-tree/update-ref.
    mode: busy ? "plumbing" : "working-tree",
  };
}

/**
 * Pre-check `branch` against `repo`, and when it conflicts, hand it to the
 * pipeline instead of throwing (FR-012a (1)).
 *
 * Returns `{ ok: true }` when there is nothing to do or the conflict was
 * resolved, or `{ ok: false, message, sessionId, conversationId }` when the
 * resolution genuinely did not complete — in which case the caller aborts the
 * promote, exactly as the old throw did, but now with a session to look at and
 * a rollback tag. `main`/base is never left conflicted either way (FR-017).
 */
export async function resolveCoupledConflicts(repo, branch, onEscalate) {
  const conflict = await coupledConflicts(repo, branch);
  if (!conflict) return { ok: true };

  const { busy, base } = await coupledMergeTarget(repo);
  slog("warn", "promote", `${repo.id}: ${branch} conflicts with ${base} — escalating to the conflict-resolution agent`, { branch });

  let outcome;
  try {
    outcome = await reconcileViaApi(
      {
        repoPath: repo.root,
        sourceRef: branch,
        strategy: "merge",
        ...workContextFor(repo, base, busy),
        operationLabel: "feature promote (coupled repo)",
        escalationContext: `Supervisor feature-promote pre-check: merging "${branch}" into "${base}" in the ${repo.id} repo conflicts.\n${conflict}`,
        completion: {
          kind: busy ? "plumbing-merge" : "merge",
          strategy: "merge",
          plumbingBaseBranch: base,
        },
      },
      onEscalate,
    );
  } catch (e) {
    // The pipeline itself was unreachable (BOS not up, job failed to start).
    // That is NOT a silent pass — the promote must still stop here, before
    // anything irreversible happens.
    return { ok: false, message: `${repo.id}: could not escalate the conflict: ${e?.message || e}\n${conflict}` };
  }

  if (outcome.status === "success" || outcome.status === "escalated") {
    slog("info", "promote", `${repo.id}: conflict with ${base} resolved (${outcome.status})`, { branch });
    return { ok: true, sessionId: outcome.sessionId, conversationId: outcome.devopsConversationId };
  }
  return {
    ok: false,
    sessionId: outcome.sessionId,
    conversationId: outcome.devopsConversationId,
    message:
      `${repo.id}: the conflict between ${branch} and ${base} was not resolved ` +
      `(${outcome.sessionStatus || outcome.status}): ${outcome.error?.message || "no detail"}. ` +
      `Roll back with \`git reset --hard ${outcome.rollbackTag}\` in ${repo.root} if needed.`,
  };
}

/** Remove a repo's worktree registration for `dst` (dir may already be
 *  gone). Always recorded via `warnings` on failure — a leftover worktree
 *  registration is exactly the class of bug that left branches undeletable
 *  on a later attempt. */
async function removeCoupledWorktree(repo, dst, warnings) {
  await mutate(`${repo.id}: remove worktree ${dst}`, () => git(["worktree", "remove", "--force", dst], repo.root), warnings);
  await mutate(`${repo.id}: prune worktrees`, () => git(["worktree", "prune"], repo.root), warnings);
}

/**
 * Merge `branch` into `repo`'s current primary branch, then drop the
 * worktree + branch. Called right after the code promote succeeds (before
 * the preview's data clone/worktree removal, since a coupled worktree lives
 * inside it).
 *
 * If the primary checkout is busy (detached HEAD — no branch to merge into)
 * the merge is done via plumbing (merge-base + `merge-tree --write-tree` +
 * commit-tree + update-ref): the ref advances but the working directory is
 * never touched.
 *
 * A merge failure here is a REAL, user-visible partial-promote outcome — the
 * code already landed on base, but this repo's content didn't. It is
 * recorded into `warnings` (which flows all the way to the promote HTTP
 * response, see lib/promote.mjs), never just logged and silently dropped —
 * this is the exact bug class (silent spec-store/user-apps merge failure)
 * this refactor exists to eliminate.
 */
export async function promoteCoupled(repo, branch, dst, warnings, onEscalate) {
  if (!(await refExists(repo.root, `refs/heads/${branch}`))) return;
  await removeCoupledWorktree(repo, dst, warnings);
  const { busy, base } = await coupledMergeTarget(repo);
  try {
    if (!busy) {
      await git([...GIT_IDENTITY, "merge", "--no-edit", branch], repo.root);
      slog("info", "promote", `${repo.id}: merged ${branch} onto ${base}`, { branch });
    } else {
      const baseTip = await git(["rev-parse", base], repo.root);
      const branchTip = await git(["rev-parse", branch], repo.root);
      const mb = await git(["merge-base", base, branch], repo.root);
      const { stdout } = await exec("git", ["merge-tree", "--write-tree", `--merge-base=${mb}`, baseTip, branchTip], { cwd: repo.root, maxBuffer: 8 * 1024 * 1024 });
      const treeSha = stdout.trim().split("\n")[0];
      const mergeCommit = await git([...GIT_IDENTITY, "commit-tree", treeSha, "-p", baseTip, "-p", branchTip, "-m", `${repo.kind}: merge ${branch}`], repo.root);
      await git(["update-ref", `refs/heads/${base}`, mergeCommit], repo.root);
      slog("info", "promote", `${repo.id}: merged ${branch} into ${base} via plumbing (primary checkout busy)`, { branch });
    }
    await mutate(`${repo.id}: delete merged branch ${branch}`, () => git(["branch", "-D", branch], repo.root), warnings);
  } catch (e) {
    // 035 (FR-012a (2)): this used to end here — `merge --abort` plus a
    // "merge manually in <root>" warning, and nothing else. It now routes
    // through the pipeline, which escalates to the conflict-resolution agent
    // with this repo's working context. Only if THAT doesn't land it does the
    // warning survive to the promote response.
    await mutate(`${repo.id}: abort failed merge`, () => git(["merge", "--abort"], repo.root), warnings);
    slog("warn", "promote", `${repo.id}: merge of ${branch} conflicted after code promote — escalating`, { branch });
    const resolved = await resolveCoupledConflicts(repo, branch, onEscalate).catch((err) => ({
      ok: false,
      message: `${repo.id}: escalation failed: ${err?.message || err}`,
    }));
    if (resolved.ok) {
      slog("info", "promote", `${repo.id}: merged ${branch} onto ${base} via conflict resolution`, { branch });
      await mutate(`${repo.id}: delete merged branch ${branch}`, () => git(["branch", "-D", branch], repo.root), warnings);
      return;
    }
    const msg = `${repo.id}: merge of ${branch} FAILED after code promote — ${resolved.message || e?.message || e}`;
    slog("error", "promote", msg, { branch });
    warnings.push(msg);
  }
}

/** Drop the coupled branch + worktree registration (Discard). Committed
 *  canonical history is untouched; uncommitted worktree edits die with the
 *  worktree, same as code. */
export async function discardCoupled(repo, branch, dst, warnings) {
  if (dst) await removeCoupledWorktree(repo, dst, warnings);
  else await mutate(`${repo.id}: prune worktrees`, () => git(["worktree", "prune"], repo.root), warnings);
  await mutate(`${repo.id}: delete branch ${branch}`, () => git(["branch", "-D", branch], repo.root), warnings);
}

/** On startup: drop stale worktree registrations for every coupled repo
 *  (their worktrees lived inside code worktrees the Supervisor is about to
 *  remove) so a later mount/branch-delete can't fail on them. */
export async function pruneAllCoupledWorktrees() {
  for (const s of await listSpecStores()) await git(["worktree", "prune"], s.root).catch(() => {});
  await git(["worktree", "prune"], APPS_REPO).catch(() => {});
}
