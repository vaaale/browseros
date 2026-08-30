import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WORKTREES, CANONICAL_DATA, REPO } from "./config.mjs";
import { git, meaningfulDirtyLines } from "./gitutil.mjs";
import { state } from "./state.mjs";
import { slog } from "./log.mjs";

const exec = promisify(execFile);

// ---------------------------------------------------------------- data clone (reads the datafs setting)
async function isolationMethod() {
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(CANONICAL_DATA, "config", "datafs.json"), "utf8"));
    return cfg.method || "auto";
  } catch {
    return "auto";
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
  try {
    if (method === "reflink") return await run(["-a", "--reflink=auto", CANONICAL_DATA, target]);
    if (method === "copy") return await run(["-a", CANONICAL_DATA, target]);
    // auto / hardlink → hardlink farm, fall back to a full copy.
    return await run(["-al", CANONICAL_DATA, target]);
  } catch {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    return await run(["-a", CANONICAL_DATA, target]);
  }
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
  try {
    await run(["-a", "--reflink=auto", path.join(REPO, "node_modules"), nm]);
  } catch {
    // `cp` without --reflink support (e.g. BSD/macOS): fall back to a plain copy.
    await fs.rm(nm, { recursive: true, force: true }).catch(() => {});
    await run(["-a", path.join(REPO, "node_modules"), nm]).catch(() => {});
  }
  for (const f of [".env", ".env.local"]) {
    await fs.copyFile(path.join(REPO, f), path.join(wt, f)).catch(() => {});
  }
}

// Create/replace the BASE worktree: detached at `commit` so it never
// conflicts with REPO's own checkout of baseBranch. Fixed location (base is
// a singleton).
export async function addBaseWorktree(commit) {
  const wt = path.join(WORKTREES, "base");
  await git(["worktree", "remove", "--force", wt]).catch(() => {}); // idempotent teardown of whatever was here before; `worktree add --detach` below still throws if the path genuinely can't be reused
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(WORKTREES, { recursive: true });
  await git(["worktree", "add", "--detach", wt, commit]);
  await hydrateWorktree(wt);
  return wt;
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
  } catch {
    return false;
  }
  let head, worktreeHead, branchTip;
  try {
    head = await git(["rev-parse", "--abbrev-ref", "HEAD"], wt);
    if (head !== branch) return false;
    worktreeHead = await git(["rev-parse", "HEAD"], wt);
    branchTip = await git(["rev-parse", branch]);
  } catch {
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
  await git(["worktree", "remove", "--force", wt]).catch(() => {}); // best-effort teardown of a stale/unhealthy worktree; `worktree add` below throws if the path genuinely can't be reused
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.dirname(wt), { recursive: true });
  // Clear any stale worktree registration (e.g. a worktree dir removed by
  // hand, or a leftover lock) so `worktree add` can't fail with "already
  // registered"/"already checked out" — the failure that would otherwise
  // push the caller into editing the live checkout in place
  // (specs/017-central-logging diagnosis).
  await git(["worktree", "prune"]).catch(() => {}); // pruning is inherently best-effort; the `worktree add` below still throws if it genuinely can't proceed
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
  await git(["worktree", "prune"]).catch(() => {}); // pruning is inherently best-effort — nothing downstream depends on this succeeding beyond the removals below, which independently verify via `worktree list`
  const list = await git(["worktree", "list", "--porcelain"]).catch(() => "");
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length).trim();
    if (wt && wt !== REPO && wt.startsWith(WORKTREES)) {
      await git(["worktree", "remove", "--force", wt]).catch((e) => slog("warn", "reconcile", `failed to remove stale worktree ${wt}: ${e?.message || e}`));
      await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
    }
  }
  await git(["worktree", "prune"]).catch(() => {});
}
