import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WORKTREES, CANONICAL_DATA, REPO } from "./config.mjs";
import { git, meaningfulDirtyLines, GIT_IDENTITY } from "./gitutil.mjs";
import { state } from "./state.mjs";
import { slog } from "./log.mjs";
import { specStoreReposFor, commitCoupled } from "./coupled-repos.mjs";

const exec = promisify(execFile);

// ---------------------------------------------------------------- data clone (reads the datafs setting)
async function isolationMethod() {
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(CANONICAL_DATA, "config", "datafs.json"), "utf8"));
    return cfg.method || "auto";
  } catch (e) {
    // ENOENT (no config written yet) is the expected, common case — "auto" is
    // its documented default. Anything else (malformed JSON, a permissions
    // error) silently falling back to the same default would hide a real
    // misconfiguration, so only that's worth a warning.
    if (e?.code !== "ENOENT") slog("warn", "provision", `reading datafs.json failed, defaulting to "auto": ${e?.message || e}`);
    return "auto";
  }
}

// installItemLink (src/system/marketplace/install/symlinkManager.ts) always
// creates dataDir()/system/<id> as an ABSOLUTE symlink. For an item installed
// on base BEFORE a preview's clone ever existed, that absolute target points
// into CANONICAL_DATA — and `cp -a` preserves a symlink's target string
// byte-for-byte, so the clone's own copy of that same symlink still points
// back into CANONICAL_DATA's user-apps, never into the clone's OWN
// branch-coupled user-apps mount (coupled-repos.mjs's mountCoupled). Any edit
// an agent makes to that item inside the preview's mounted user-apps worktree
// is then invisible when the SAME preview serves the app — the serving path
// (src/app/apps/[...slug]/route.ts's itemLinkPath) reads straight through the
// stale symlink to base's unedited copy. Retargeting every user-apps-sourced
// item symlink to the clone's own user-apps closes that gap. Symlinks whose
// provenance is something else (e.g. a marketplace clone) are left untouched
// — only user-apps is branch-coupled/mounted per preview, so there is no
// clone-local equivalent to redirect a marketplace item's symlink to.
async function retargetUserAppsItemSymlinks(cloneDir, finalTarget) {
  const systemDir = path.join(cloneDir, "system");
  const canonicalUserApps = path.join(CANONICAL_DATA, "user-apps");
  const cloneUserApps = path.join(finalTarget, "user-apps");
  let entries;
  try {
    entries = await fs.readdir(systemDir, { withFileTypes: true });
  } catch (e) {
    if (e?.code !== "ENOENT") slog("warn", "provision", `reading ${systemDir} for item-symlink retargeting failed: ${e?.message || e}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(systemDir, entry.name);
    let resolvedTarget;
    try {
      resolvedTarget = path.resolve(systemDir, await fs.readlink(linkPath));
    } catch (e) {
      slog("warn", "provision", `reading item symlink ${linkPath} failed — leaving it untouched: ${e?.message || e}`);
      continue;
    }
    const rel = path.relative(canonicalUserApps, resolvedTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    try {
      await fs.rm(linkPath, { force: true });
      await fs.symlink(path.join(cloneUserApps, rel), linkPath, "dir");
    } catch (e) {
      slog("warn", "provision", `retargeting item symlink ${linkPath} into this clone's user-apps failed: ${e?.message || e}`);
    }
  }
}

export async function provisionClone(target) {
  // Idempotent: a preview's data-clone persists across Supervisor restarts
  // (it lives on a bind-mounted host directory in the bastion deployment, or
  // just on disk standalone). If it already exists, it may hold data drift
  // from the preview's own testing — never blow it away just because the
  // Supervisor restarted; only a genuinely missing clone gets
  // (re-)provisioned.
  if (await fs.stat(target).catch(() => null)) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const method = await isolationMethod();
  const run = (args) => exec("cp", args, { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 });
  // Copy into a sibling staging path and only `rename` it onto `target` once
  // the copy is FULLY complete — `rename` is atomic (same directory, same
  // filesystem), so `target` never exists in a partially-copied state.
  // Without this, the `fs.stat(target)` existence check above can't tell a
  // finished clone from one interrupted mid-copy (Supervisor crash/restart,
  // disk full, a killed `cp`): the directory is already there, so every
  // later provision call treats a broken, partial clone as good forever —
  // the preview then silently runs against missing/incomplete data with no
  // error anywhere. A leftover staging dir here can only be from an
  // interrupted PREVIOUS attempt (the caller already serializes concurrent
  // provisions for the same target via preview.mjs's `previewProvisioning`),
  // so it's always safe to clear before starting.
  const staging = `${target}.provisioning`;
  await fs.rm(staging, { recursive: true, force: true }).catch((e) =>
    slog("warn", "provision", `cleanup of stale in-progress clone ${staging} failed: ${e?.message || e}`),
  );
  try {
    if (method === "reflink") await run(["-a", "--reflink=auto", CANONICAL_DATA, staging]);
    else if (method === "copy") await run(["-a", CANONICAL_DATA, staging]);
    // auto / hardlink → hardlink farm, fall back to a full copy.
    else await run(["-al", CANONICAL_DATA, staging]);
  } catch (e) {
    slog("warn", "provision", `${method} clone of ${target} failed, falling back to plain copy: ${e?.message || e}`);
    await fs.rm(staging, { recursive: true, force: true }).catch((rmErr) =>
      slog("error", "provision", `cleanup before fallback copy failed for ${staging}: ${rmErr?.message || rmErr}`),
    );
    await run(["-a", CANONICAL_DATA, staging]);
  }
  await retargetUserAppsItemSymlinks(staging, target);
  await fs.rename(staging, target);
}

// ---------------------------------------------------------------- worktree + process lifecycle
// Worktrees don't get node_modules (gitignored). A symlink is rejected by
// Turbopack ("points out of the filesystem root"), so clone the repo's
// node_modules into the worktree. Use copy-on-write (--reflink=auto): cheap
// on filesystems that support it (btrfs/XFS/APFS) and a full copy elsewhere.
// NOT a hardlink farm — hardlinks share inodes with the running base and
// every other worktree, so an in-place npm/postinstall/patch write to an
// EXISTING node_modules file would bleed across trees and could corrupt the
// live base at runtime. CoW breaks the share on first write, so a preview's
// dependency change stays isolated. Also carry env secrets (also gitignored).
export async function hydrateWorktree(wt) {
  const nm = path.join(wt, "node_modules");
  const run = (args) => exec("cp", args, { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  // Same reasoning as provisionClone's staging dance: copy into a sibling
  // path and `rename` it onto `nm` only once complete, so isHealthyWorktree's
  // existence check (below) can never mistake an interrupted copy — Supervisor
  // restart, killed `cp`, disk full — for a finished one and skip re-hydrating
  // a worktree that will then fail to build for a reason nobody can see.
  const staging = `${nm}.provisioning`;
  await fs.rm(staging, { recursive: true, force: true }).catch((e) =>
    slog("warn", "provision", `cleanup of stale in-progress node_modules copy ${staging} failed: ${e?.message || e}`),
  );
  try {
    await run(["-a", "--reflink=auto", path.join(REPO, "node_modules"), staging]);
  } catch (e) {
    // `cp` without --reflink support (e.g. BSD/macOS): fall back to a plain copy.
    slog("warn", "provision", `reflink copy of node_modules into ${wt} failed, falling back to plain copy: ${e?.message || e}`);
    await fs.rm(staging, { recursive: true, force: true }).catch((rmErr) =>
      slog("error", "provision", `cleanup before fallback node_modules copy failed for ${staging}: ${rmErr?.message || rmErr}`),
    );
    await run(["-a", path.join(REPO, "node_modules"), staging]).catch((cpErr) => {
      slog("error", "provision", `fallback node_modules copy into ${staging} failed — worktree will likely fail to build: ${cpErr?.message || cpErr}`);
      throw cpErr; // both copy strategies failed — nothing to promote, must not silently continue
    });
  }
  await fs.rename(staging, nm);
  for (const f of [".env", ".env.local"]) {
    await fs.copyFile(path.join(REPO, f), path.join(wt, f)).catch((e) => {
      // Both files are optional (`.env.local` in particular is commonly
      // absent) — only a failure that ISN'T "the source file doesn't exist"
      // is worth surfacing.
      if (e?.code !== "ENOENT") slog("warn", "provision", `copying ${f} into ${wt} failed: ${e?.message || e}`);
    });
  }
}

// True if `wt` is already a healthy worktree checked out on `branch` at the
// branch's current tip, with its node_modules copy present — lets
// addWorktreeForBranch() skip the expensive destroy+recreate (git worktree
// add + a full node_modules copy, potentially GBs) when nothing has actually
// changed since the last time it ran. Restarting the Supervisor process
// (i.e. every container restart, not just a full recreate) used to pay this
// cost unconditionally for every known feature branch, every time.
export async function isHealthyWorktree(wt, branch) {
  try {
    await git(["rev-parse", "--git-dir"], wt);
  } catch (e) {
    // Any failure here safely means "not healthy" (worst case: the caller
    // pays for a rebuild it didn't strictly need) — but worth a trace so a
    // persistently-failing "healthy" check isn't mysterious.
    slog("debug", "provision", `worktree health check: ${wt} has no readable git dir: ${e?.message || e}`, { branch });
    return false;
  }
  let head, worktreeHead, branchTip;
  try {
    head = await git(["rev-parse", "--abbrev-ref", "HEAD"], wt);
    if (head !== branch) return false;
    worktreeHead = await git(["rev-parse", "HEAD"], wt);
    branchTip = await git(["rev-parse", branch]);
  } catch (e) {
    slog("debug", "provision", `worktree health check: reading branch/commit state of ${wt} failed: ${e?.message || e}`, { branch });
    return false;
  }
  if (worktreeHead !== branchTip) return false;
  return !!(await fs.stat(path.join(wt, "node_modules")).catch(() => null));
}

// Create/replace a worktree for an EXISTING branch at WORKTREES/<branch>.
// Branch names may contain '/', kept as nested dirs (git ref rules forbid
// foo AND foo/bar at once, so no path collision); mkdir the parent.
export async function addWorktreeForBranch(branch) {
  const wt = path.join(WORKTREES, branch);
  if (await isHealthyWorktree(wt, branch)) return wt;
  // Best-effort teardown of a stale/unhealthy worktree — `worktree add` below
  // still throws if the path genuinely can't be reused, so a failure here
  // isn't fatal, but it must be visible: it's the first sign something about
  // this worktree is in a state the rest of this function doesn't expect.
  await git(["worktree", "remove", "--force", wt]).catch((e) => slog("warn", "provision", `remove of stale worktree ${wt} failed: ${e?.message || e}`, { branch }));
  await fs.rm(wt, { recursive: true, force: true }).catch((e) => slog("error", "provision", `cleanup of stale worktree dir ${wt} failed: ${e?.message || e}`, { branch }));
  await fs.mkdir(path.dirname(wt), { recursive: true });
  // Clear any stale worktree registration (e.g. a worktree dir removed by
  // hand, or a leftover lock) so `worktree add` can't fail with "already
  // registered"/"already checked out" — the failure that would otherwise
  // push the caller into editing the live checkout in place
  // (specs/017-central-logging diagnosis).
  await git(["worktree", "prune"]).catch((e) => slog("warn", "provision", `worktree prune before adding ${wt} failed: ${e?.message || e}`, { branch })); // best-effort; the `worktree add` below still throws if it genuinely can't proceed
  await git(["worktree", "add", wt, branch]);
  await hydrateWorktree(wt);
  return wt;
}

// Post-condition safety gate: verify the live checkout (REPO) is still on
// the expected base branch and has no uncommitted changes. If either
// invariant is violated we log a loud ERROR and attempt a safe restore
// (checkout baseBranch + reset --hard) so the running base is never left in
// a dirty/wrong-branch state. Returns true when a violation was detected.
// Callers must fail the candidate: restoring the live checkout means the
// agent edited the wrong tree, so reporting a successful preview would be
// misleading.
//
// A failed read here (branch/status genuinely unreadable, not just "clean")
// must never be silently treated as "everything is fine" — that's exactly
// the anti-pattern this gate exists to catch elsewhere. So both reads are
// plain throwing `git()` calls; the outer try/catch below treats ANY
// exception (including from the reads themselves) as a violation needing
// investigation, never as an all-clear.
export async function assertRepoIntegrity(context = "") {
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = await git(["status", "--porcelain"]);
    const meaningfulDirty = meaningfulDirtyLines(dirty);
    const violated = branch !== state.baseBranch || meaningfulDirty.length > 0;
    if (!violated) return false; // fast path — everything is fine

    const msg =
      `SAFETY GATE VIOLATED${context ? ` (${context})` : ""}: ` +
      `REPO branch="${branch}" (expected "${state.baseBranch}"), dirty="${dirty || ""}". ` +
      `Something edited or branched the live checkout instead of the isolated preview worktree. ` +
      `Attempting safe restore.`;
    slog("error", "safety-gate", msg, { branch, baseBranch: state.baseBranch, dirty: dirty || "" });

    // Attempt restore: switch back to baseBranch and discard any
    // uncommitted changes. Best-effort by nature (we're already in a
    // violated, unexpected state) — the after-state re-read below is what
    // actually confirms whether the restore worked, not these calls
    // succeeding silently.
    if (branch !== state.baseBranch) {
      await git(["checkout", state.baseBranch]).catch((e) => slog("warn", "safety-gate", `restore checkout failed: ${e?.message || e}`));
    }
    if (dirty) {
      await git(["reset", "--hard", "HEAD"]).catch((e) => slog("warn", "safety-gate", `restore reset failed: ${e?.message || e}`));
      await git(["clean", "-fd"]).catch((e) => slog("warn", "safety-gate", `restore clean failed: ${e?.message || e}`));
    }

    const afterBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "(unreadable)");
    const afterDirty = await git(["status", "--porcelain"]).catch(() => "(unreadable)");
    slog("warn", "safety-gate", `restore complete: branch="${afterBranch}", dirty="${afterDirty || ""}"`);
    return true;
  } catch (e) {
    slog("error", "safety-gate", `assertRepoIntegrity check itself failed: ${e.message || e}`);
    return true;
  }
}

// On startup, remove the Supervisor's own leftover worktrees (under
// WORKTREES) from a previous run (their processes died with the old
// supervisor). The BRANCHES survive, so an orphaned preview stays selectable
// from the dropdown — this just prevents `git worktree add` collisions and
// stale-port confusion. Coupled-repo (spec-store/user-apps) worktree
// registrations are handled separately by coupled-repos.mjs's
// pruneAllCoupledWorktrees — their worktrees lived inside these code
// worktrees, so both must run at boot, in either order.
export async function reconcileWorktrees() {
  await git(["worktree", "prune"]).catch((e) => slog("warn", "reconcile", `initial worktree prune failed: ${e?.message || e}`)); // best-effort — nothing downstream depends on this succeeding beyond the removals below, which independently verify via `worktree list`
  const list = await git(["worktree", "list", "--porcelain"]).catch((e) => {
    slog("error", "reconcile", `worktree list failed — cannot reconcile leftover worktrees this boot: ${e?.message || e}`);
    return "";
  });
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length).trim();
    if (wt && wt !== REPO && wt.startsWith(WORKTREES)) {
      // A worktree here can hold UNCOMMITTED edits — e.g. an agent's
      // dev_delegate wrote files but the Supervisor process restarted
      // (crash, manual restart, redeploy) before buildAndStart's own commit
      // step ran. Blindly removing it, as this used to do unconditionally,
      // silently destroyed that work: the branch survives (it's just a git
      // ref), but whatever hadn't been committed onto it is gone the moment
      // `fs.rm` runs, and every later rebuild of the branch just reflects
      // the last real commit — reading as "my change isn't in the preview"
      // with no error anywhere. Commit first (the exact same safety-net
      // commit buildAndStart already makes routinely) so a restart can never
      // lose in-flight edits; only genuinely clean worktrees are destroyed.
      let branch = null;
      try {
        branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], wt);
      } catch (e) {
        // Can't determine the branch, so the safety-commit below is skipped
        // entirely — exactly the case where it matters most. Log loudly:
        // this worktree is about to be removed with no protection.
        slog("error", "reconcile", `could not read branch of ${wt} — skipping its safety-net commit before removal, any uncommitted edits will be lost: ${e?.message || e}`);
        branch = null;
      }
      if (branch && branch !== "HEAD") {
        await git(["add", "-A"], wt).catch((e) =>
          slog("error", "reconcile", `git add failed in ${wt} before safety-committing it — some edits may not get staged: ${e?.message || e}`, { branch }),
        );
        const dirty = await git(["status", "--porcelain"], wt).catch((e) => {
          slog("error", "reconcile", `git status failed in ${wt} — cannot tell if it holds uncommitted edits, treating it as dirty to be safe: ${e?.message || e}`, { branch });
          return "?"; // unreadable status must never be read as "clean" — fail toward attempting the safety commit
        });
        if (dirty) {
          await git([...GIT_IDENTITY, "commit", "-m", `BOS candidate (${branch}) — safety-net commit before supervisor restart`], wt).catch((e) =>
            slog("error", "reconcile", `failed to safety-commit dirty worktree ${wt} before removing it on restart — uncommitted work may be lost: ${e?.message || e}`, { branch }),
          );
        }
        // Spec-store worktrees are mounted NESTED inside this one
        // (`<wt>/specs/<store>`) — the `fs.rm` below would take their
        // uncommitted edits down with it too, same risk as the code above.
        for (const repo of await specStoreReposFor(wt)) {
          await commitCoupled(repo, repo.dst, branch).catch((e) =>
            slog("error", "reconcile", `failed to safety-commit dirty spec store ${repo.id} in ${wt} before removing it on restart — uncommitted work may be lost: ${e?.message || e}`, { branch }),
          );
        }
      }
      await git(["worktree", "remove", "--force", wt]).catch((e) => slog("warn", "reconcile", `failed to remove stale worktree ${wt}: ${e?.message || e}`));
      await fs.rm(wt, { recursive: true, force: true }).catch((e) => slog("error", "reconcile", `failed to delete worktree dir ${wt}: ${e?.message || e}`));
    }
  }
  await git(["worktree", "prune"]).catch((e) => slog("warn", "reconcile", `final worktree prune failed: ${e?.message || e}`));
}
