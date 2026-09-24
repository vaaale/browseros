import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SPECS_ROOT, APPS_REPO, CANONICAL_DATA } from "./config.mjs";
import { git, refExists, mutate, GIT_IDENTITY } from "./gitutil.mjs";
import { reconcileViaApi } from "./reconcile-client.mjs";
import { runAutoPush } from "./push.mjs";
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
/** The repo's own default branch, for when HEAD cannot say.
 *
 *  `origin/HEAD` first (what the remote calls default), then whichever of the
 *  conventional names actually EXISTS. The literal "master" this replaces was a
 *  guess, and a wrong one: the user's `user-apps` has no master — its default is
 *  `main` — so a detached HEAD there made both callers fail with
 *  `fatal: invalid reference: master`, one of them (mountCoupled) while cutting
 *  the branch a marketplace change lives on. */
async function defaultBranchOf(root) {
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root).catch(() => null);
  if (head) {
    const name = head.replace(/^origin\//, "");
    if (await refExists(root, `refs/heads/${name}`)) return name;
  }
  for (const name of ["main", "master"]) {
    if (await refExists(root, `refs/heads/${name}`)) return name;
  }
  // Last resort: any local branch at all. Naming one that exists is always
  // better than naming one that does not — and if there are none, say so
  // rather than hand a caller a ref that cannot resolve.
  const any = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], root).catch(() => ""))
    .split("\n").map((l) => l.trim()).filter(Boolean);
  if (any.length) {
    slog("warn", "specs", `${root}: no origin/HEAD and no main/master — falling back to "${any[0]}"`);
    return any[0];
  }
  throw new Error(`${root} has no branches; cannot determine a default to branch from or merge into.`);
}

async function coupledMergeTarget(repo) {
  const cur = await symbolicRefOrNull(repo.root);
  return { busy: !cur, base: cur ?? (await defaultBranchOf(repo.root)) };
}

/** The git repo a store root belongs to: itself, or one level up.
 *
 *  Ported from `nearestRepoRoot` in src/lib/specs/stores.ts, whose bound and
 *  reasoning this mirrors deliberately — a store that IS its own repo matches on
 *  the first step, while a registered project keeps its specs where the
 *  framework's CLI expects them (`<repo>/openspec`, `<repo>/specs`) so the repo
 *  is one level up. */
async function nearestRepoRoot(storeRoot) {
  let dir = storeRoot;
  for (let up = 0; up <= 1; up++) {
    if (await fs.access(path.join(dir, ".git")).then(() => true).catch(() => false)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// A store = an entry under SPECS_ROOT carrying a manifest, belonging to a git
// repo at or just above it.
//
// THIS IS THE SAME RULE AS src/lib/specs/stores.ts and has to stay that way:
// what BOS treats as a store and what the Supervisor mounts for a feature branch
// must be the same set, or a store BOS will happily write to has nowhere to
// write. The two copies drifted, and both halves of the drift were silent:
//
//   - `e.isDirectory()` is FALSE for a symlink (readdir does not follow), and a
//     store is routinely a symlink into a repo kept outside the data dir — which
//     is how BOS_SPECS_ROOT points at stores elsewhere. Every store in such a
//     deployment was skipped, so NOTHING was ever mounted and every
//     branch-coupled write fell back or failed, with no error naming a store.
//   - Requiring `.git` INSIDE the store root skipped any store that is a
//     SUBDIRECTORY of its repo — exactly the shape 050 introduced for registered
//     repositories, whose specs live at `<repo>/specs` or `<repo>/openspec`.
//
// `root` is the REPO (what `git worktree add` runs in); `offset` is the store's
// path within it, so a mount can be addressed back down to the store itself.
export async function listSpecStores() {
  let entries;
  try {
    entries = await fs.readdir(SPECS_ROOT, { withFileTypes: true });
  } catch (e) {
    // ENOENT (no specs root provisioned yet) is expected and silent; anything
    // else (permissions, a broken mount) means store discovery is silently
    // returning "no stores" when the real answer is "couldn't check" —
    // exactly the kind of gap that reads as "specs are just empty".
    if (e?.code !== "ENOENT") slog("warn", "specs", `reading SPECS_ROOT (${SPECS_ROOT}) failed: ${e?.message || e}`);
    return [];
  }
  const stores = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const link = path.join(SPECS_ROOT, e.name);
    // Resolve through the link before deciding anything: walking up from the
    // link's own location would climb the data dir instead of the real repo.
    let storeRoot;
    try {
      storeRoot = await fs.realpath(link);
      if (!(await fs.stat(storeRoot)).isDirectory()) continue;
      await fs.access(path.join(storeRoot, "spec-store.json"));
    } catch {
      continue; // not a store — the normal case for anything else in here
    }
    const root = await nearestRepoRoot(storeRoot);
    if (!root) {
      // A manifest with no repo anywhere near it is a real misconfiguration, not
      // a normal "not a store" — and it ends as specs that silently never mount.
      slog("warn", "specs", `store "${e.name}" has a manifest but no git repo at or above ${storeRoot}`);
      continue;
    }
    // `owner`/`writable` decide whether this store may EVER be branched.
    // bos-system-specs is documented read-only and was getting `bos/*` branches
    // created in it anyway — wrong on its face, and invisible until someone
    // looked at a branch list.
    let owner = "user";
    let writable = true;
    try {
      const m = JSON.parse(await fs.readFile(path.join(storeRoot, "spec-store.json"), "utf8"));
      if (typeof m.owner === "string") owner = m.owner;
      if (typeof m.writable === "boolean") writable = m.writable;
    } catch (err) {
      // The manifest was readable a moment ago (the access check above), so a
      // failure here is real. Defaulting to writable would re-enable branching a
      // store BOS must not touch.
      slog("warn", "specs", `store "${e.name}": could not read spec-store.json (${err?.message || err}) — treating as read-only`);
      writable = false;
    }
    stores.push({ id: e.name, root, storeRoot, offset: path.relative(root, storeRoot), kind: "spec-store", owner, writable });
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

/** The spec-store worktrees ACTUALLY mounted under `<worktree>/specs/`, read
 *  from disk.
 *
 *  For teardown only. A cleanup path must protect what is really there, not
 *  what the branch's scope says should be there: a mount made under an older
 *  scope, or by an older build, still holds uncommitted work, and a scoped list
 *  would walk straight past it and `fs.rm` it.
 *
 *  This REPLACED an unscoped `specStoreReposFor(worktree)` that returned every
 *  store on disk and was used for mounting too — which is how `beginPreview`
 *  kept creating `bos/*` in every registered repository long after
 *  `coupledReposFor` was scoped. There is now no way to ask this module for "all
 *  the stores, mount destinations included" and get a mountable list back. */
export async function mountedSpecStoresIn(worktree) {
  const dir = path.join(worktree, "specs");
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    // No `specs/` is the ordinary case (a branch that never touched specs).
    // Anything else means we are about to delete a directory we could not
    // inspect, so it has to be said out loud.
    if (e?.code !== "ENOENT") slog("error", "specs", `could not list mounted spec stores in ${dir} — removing it without safety-committing them: ${e?.message || e}`);
    return [];
  }
  const mounted = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dst = path.join(dir, e.name);
    if (!(await fs.access(path.join(dst, ".git")).then(() => true).catch(() => false))) continue;
    mounted.push({ id: e.name, kind: "spec-store", dst });
  }
  return mounted;
}

/** The ONE scope file: canonical data, always.
 *
 *  It is deliberately NOT the preview's data clone. `provisionClone` snapshots
 *  canonical data once and then returns early forever (so a preview's own data
 *  survives a restart), which made every coupling decision read a frozen copy:
 *  re-scoping a branch never took effect, and a clone older than the scope fell
 *  back to "unscoped" — for a `repository`-scoped branch that silently drops the
 *  one repo holding the work out of the promote set, and `promoteCoupled` then
 *  skips every repo it IS handed because none of them has the branch. The work
 *  ends up stranded on a branch nobody merges, with no error anywhere.
 *
 *  A branch's scope is a global fact about that branch, written by the base
 *  server; only its RUNTIME state belongs to the clone. */
function scopesFile() {
  return path.join(CANONICAL_DATA, "system", "branch-scopes.json");
}

/** What a branch is FOR, from `data/system/branch-scopes.json` (branch-scope.ts).
 *
 *  Absent is a real and ordinary state — a branch created before scoping
 *  existed, or by a path that does not record one — so it is REPORTED rather
 *  than guessed at. See `coupledReposFor` for what absence then means. */
async function branchScope(dataDir, branch) {
  if (!branch) return undefined;
  try {
    const all = JSON.parse(await fs.readFile(scopesFile(), "utf8"));
    return all?.[branch];
  } catch (e) {
    if (e?.code !== "ENOENT") {
      slog("warn", "specs", `reading branch-scopes.json failed: ${e?.message || e} — coupling BOS-owned repos only`);
    }
    return undefined;
  }
}

/** Every coupled repo a promote/discard for `branch` must touch. `dst` is where
 *  each is (or will be) mounted as a worktree for this branch's preview.
 *
 *  SCOPED, because it was not. A change to one marketplace app created its
 *  branch in FIVE repositories — BOS's source, user-apps, user-specs, the
 *  read-only bos-system-specs, and a user's entirely unrelated `police-mcp`.
 *  The old set ("every spec store, plus user-apps") was correct when the only
 *  stores were BOS's own two; 050 made an arbitrary registered repository into a
 *  spec store and nothing here knew.
 *
 *    bos-core          BOS's source (the worktree itself) + user-specs
 *    marketplace-item  BOS's source + user-apps
 *    repository        that repository only
 *
 *  A store that is not WRITABLE is excluded from every scope: `bos-system-specs`
 *  is read-only by documentation, and was being branched regardless.
 *
 *  UNSCOPED falls back to BOS's OWN repos — user-specs and user-apps — and never
 *  to a registered repository. A branch created before this existed keeps
 *  working, and the reported damage is still fixed for it, because the damage
 *  was never in the BOS-owned repos. */
export async function coupledReposFor(worktree, dataDir, branch) {
  const scope = await branchScope(dataDir, branch);
  const stores = (await listSpecStores()).filter((s) => s.writable !== false && s.owner !== "system");
  const apps = { id: "user-apps", root: APPS_REPO, kind: "user-apps", dst: path.join(dataDir, "user-apps") };
  const mount = (s) => ({ ...s, dst: path.join(worktree, "specs", s.id) });
  const userSpecs = () => stores.filter((s) => s.id === "user-specs").map(mount);

  // SAY WHAT WAS DECIDED, every time. Without this, "which repositories did this
  // branch couple" is something you reconstruct from a branch list afterwards —
  // which is how the over-branching was found, and how a Supervisor still
  // running a PREVIOUS copy of this file went unnoticed for hours. A long-lived
  // process does not reload this module; a decision it prints does.
  const decided = (repos, why) => {
    if (branch) {
      slog("info", "specs", `branch "${branch}" [${why}] couples: ${repos.map((r) => r.id).join(", ") || "nothing"}`);
    }
    return repos;
  };

  if (scope?.kind === "repository") {
    const only = stores.filter((s) => s.id === scope.repoId);
    if (!only.length) {
      slog("warn", "specs", `branch "${branch}" is scoped to repository "${scope.repoId}", which is not a writable spec store`);
    }
    return decided(only.map(mount), `repository:${scope.repoId}`);
  }
  if (scope?.kind === "marketplace-item") return decided([apps], "marketplace-item");
  if (scope?.kind === "bos-core") return decided(userSpecs(), "bos-core");

  if (branch) slog("warn", "specs", `branch "${branch}" has no recorded scope — coupling BOS-owned repos only`);
  return decided([...userSpecs(), apps], "unscoped");
}

/** Mount (or refresh) `repo`'s worktree for `branch` at `dst`. Reuses an
 *  intact existing mount; otherwise prunes stale registrations and adds the
 *  worktree — on the existing branch, or a new one off the repo's current
 *  primary branch.
 *
 *  `beginPreview` (preview.mjs) remounts every coupled repo on EVERY `/begin`
 *  call, with no per-branch lock around this step (unlike the worktree/clone
 *  provisioning above it, which IS de-duped via `previewProvisioning`) — and
 *  parallel agent tool calls can issue overlapping `/begin`s for the same
 *  branch. Two concurrent callers can both see `refExists` return false
 *  (branch doesn't exist yet) and both attempt `worktree add -b`; the loser
 *  fails with "a branch named … already exists", which `beginPreview`
 *  degrades to a `mountErrors` warning rather than surfacing loudly — so the
 *  preview silently keeps running with `specs/<store>` never mounted at all,
 *  which reads as a bafflingly "blank"/misconfigured preview since anything
 *  spec-dependent has nothing to read. Rather than chase down every possible
 *  concurrent caller, make the race self-healing here: if the `-b` create
 *  loses, the winner's branch now exists — just check that out instead of
 *  failing the mount. */
export async function mountCoupled(repo, dst, branch) {
  if (repo.kind === "user-apps") await ensureAppsRepo();
  const mounted = await fs.access(path.join(dst, ".git")).then(() => true).catch(() => false);
  if (mounted) {
    let cur;
    try {
      cur = await git(["rev-parse", "--abbrev-ref", "HEAD"], dst);
    } catch (e) {
      slog("warn", "mount", `could not read current branch of existing mount ${dst}, remounting: ${e?.message || e}`, { branch });
      cur = null;
    }
    if (cur === branch) return;
  }
  await fs.rm(dst, { recursive: true, force: true }).catch((e) => slog("error", "mount", `cleanup of existing mount ${dst} failed: ${e?.message || e}`, { branch }));
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await git(["worktree", "prune"], repo.root).catch((e) => slog("warn", "mount", `worktree prune in ${repo.root} failed: ${e?.message || e}`, { branch })); // best-effort; the `worktree add` below still throws if it genuinely can't proceed
  if (await refExists(repo.root, `refs/heads/${branch}`)) {
    await git(["worktree", "add", dst, branch], repo.root);
    return;
  }
  const { base } = await coupledMergeTarget(repo);
  try {
    await git(["worktree", "add", "-b", branch, dst, base], repo.root);
  } catch (e) {
    if (!/already exists/i.test(e?.message || "")) throw e;
    await git(["worktree", "add", dst, branch], repo.root);
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
  try {
    mb = await git(["merge-base", base, branch], repo.root);
  } catch (e) {
    // This pre-check exists specifically to catch a conflict BEFORE promote's
    // point of no return — silently reading "can't compute merge-base" as
    // "no conflict" defeats that: a real problem here means promoteCoupled's
    // actual merge, later, fails unexpectedly with no pre-warning.
    slog("warn", "promote", `${repo.id}: merge-base(${base}, ${branch}) failed — cannot pre-check for conflicts: ${e?.message || e}`, { branch });
    return null;
  }
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
// Push repo's `base` branch to every autoPush-enabled remote configured for
// it (git-remotes.json, scoped by repo.id — see push.mjs's runAutoPush).
// Called only after a successful merge; a push failure is recorded as a
// warning, never thrown — the merge itself already succeeded and must not be
// undone by a push problem.
async function pushCoupledBase(repo, base, warnings) {
  const results = await runAutoPush(repo.root, base, repo.id);
  for (const r of results) {
    if (r.status === "failed") warnings.push(`${repo.id}: auto-push to ${r.remoteName} failed: ${r.error}`);
  }
}

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
    await pushCoupledBase(repo, base, warnings);
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
      await pushCoupledBase(repo, base, warnings);
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
  for (const s of await listSpecStores()) {
    await git(["worktree", "prune"], s.root).catch((e) => slog("warn", "reconcile", `worktree prune in spec store ${s.id} (${s.root}) failed: ${e?.message || e}`));
  }
  await git(["worktree", "prune"], APPS_REPO).catch((e) => slog("warn", "reconcile", `worktree prune in ${APPS_REPO} failed: ${e?.message || e}`));
}

/** Drop a branch's scope once the branch is gone (promote/discard).
 *
 *  `clearBranchScope` was written in branch-scope.ts for exactly this and wired
 *  to nothing, so every branch ever created kept an entry forever — and a REUSED
 *  branch name silently inherited the previous one's scope. The Supervisor is
 *  the process that deletes branches, so it is the one that has to do this. */
export async function clearCoupledBranchScope(branch, warnings) {
  if (!branch) return;
  let all;
  try {
    all = JSON.parse(await fs.readFile(scopesFile(), "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return;
    const msg = `could not read branch scopes to clear "${branch}": ${e?.message || e}`;
    slog("warn", "promote", msg, { branch });
    if (Array.isArray(warnings)) warnings.push(msg);
    return;
  }
  if (!all || !(branch in all)) return;
  delete all[branch];
  try {
    await fs.writeFile(scopesFile(), JSON.stringify(all, null, 2) + "\n", "utf8");
  } catch (e) {
    const msg = `could not clear the scope for "${branch}": ${e?.message || e}`;
    slog("warn", "promote", msg, { branch });
    if (Array.isArray(warnings)) warnings.push(msg);
  }
}
