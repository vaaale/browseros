import path from "node:path";

// All env-derived configuration in one place, so every module reads the same
// resolved values instead of re-parsing process.env. Resolved once at import
// time (module evaluation happens once per process either way).

export const REPO = process.env.BOS_REPO || process.cwd();
export const PUBLIC_PORT = Number(process.env.BOS_PUBLIC_PORT || 8080);
export const BASE_PORT = Number(process.env.BOS_PORT_BASE || 3000);
// Number of preview ports available ABOVE the base port: BASE_PORT+1 .. BASE_PORT+POOL_SIZE.
export const POOL_SIZE = Number(process.env.BOS_PORT_POOL_SIZE || 20);
export const WORKTREES = process.env.BOS_WORKTREES || path.join(REPO, "bos-worktrees");
export const CANONICAL_DATA = process.env.BOS_CANONICAL_DATA || path.join(REPO, "data");
export const CLONES = process.env.BOS_DATA_CLONES || path.join(REPO, "bos-data-clones");
export const REMOTE = process.env.BOS_REMOTE || "origin";
export const HEALTH_TIMEOUT_MS = Number(process.env.BOS_HEALTH_TIMEOUT_MS || 120_000);
// Reuse an already-running server as BASE (dev convenience / testing).
export const REUSE_BASE_PORT = process.env.BOS_ACTIVE_REUSE_PORT ? Number(process.env.BOS_ACTIVE_REUSE_PORT) : null;
// How often to poll the Next.js server's /api/gitfs/reconcile job status
// during a promote's reconciliation (001-external-repo-integration, US6).
export const RECONCILE_POLL_MS = Number(process.env.BOS_RECONCILE_POLL_MS || 2_000);
// Supervisor-OWNED dev base: the Supervisor spawns `next dev` for base itself
// (single-process model — just start the Supervisor). Because it owns the
// process it can npm-install + restart base on promote, with HMR during
// development.
export const BASE_DEV = /^(1|true|yes)$/i.test(process.env.BOS_BASE_DEV || "");
export const PIN_COOKIE = "bos_pin";

// Items content repo (GitFS) — dataDir()/user-apps, the user's local
// marketplace and the ONE install target for every item (apps included; there
// is no separate apps repo). App candidates are git BRANCHES here (not
// worktrees + a second server): the base BOS serves this repo's working tree,
// so checking out the candidate branch makes the in-progress app visible
// ("branch-live" preview), promote merges it to the base branch, discard
// drops it. Orthogonal to the BOS-code preview flow and needs no extra
// port/proxy.
export const APPS_REPO = path.join(CANONICAL_DATA, "user-apps");

// Container of external spec stores (018/020). Each store is mounted into a
// preview worktree at `specs/<store>/` as a GIT WORKTREE of that store,
// checked out on the SAME feature branch as the code (020-branch-coupled-
// specs) — one feature = one branch name across the BOS repo and every
// store. Promote merges both; discard drops both.
// 027 relocated the store container from <repo>/specs to <canonicalData>/specs
// so the canonical stores live in the base data volume (matching the base
// app's specsRoot() = <dataDir>/specs). Previews still get
// BOS_SPECS_ROOT=<worktree>/specs (the branch-coupled worktree mounts), so
// coupling is unchanged.
export const SPECS_ROOT = process.env.BOS_SPECS_ROOT || path.join(CANONICAL_DATA, "specs");

export const FEATURE_BRANCH_PREFIX = "bos/";
export const FEATURE_BRANCH_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,3}$/;

export const BUILD_TIMEOUT_MS = 600_000;

// Memory ceiling for the DEV base server (MB of V8 old space); 0 disables.
//
// `next dev` retains roughly 0.8 MB per request with no plateau (measured:
// 2.2 GB at boot, 7.1 GB after 4 minutes of light load, versus 130 MB / 249 MB
// steady-state for `next start`). Capping V8's old space makes Next's own dev
// memory guard fire — "⚠ Server is approaching the used memory threshold,
// restarting…" — so it recycles gracefully instead of growing until the
// kernel OOM-kills it.
//
// Two caveats, both measured:
//  - This bounds the HEAP, not total RSS. About half the footprint lives
//    outside V8's old space (other V8 spaces, code space, native/Turbopack
//    allocations), so RSS lands at roughly 2x the cap. Size it at ~half the
//    memory you are willing to give the dev server.
//  - It is a BOUND, not a fix. What retains the memory in dev is still
//    unexplained; production mode does not exhibit it at all.
export const DEV_MAX_OLD_SPACE_MB = Number(process.env.BOS_DEV_MAX_OLD_SPACE_MB ?? 2048);

// Backoff schedule for restarting a base server that died on its own. Its
// length is also the give-up threshold: after this many CONSECUTIVE failed
// restarts the Supervisor stops trying and leaves base "failed", so
// /__supervisor/health and the bastion's health probe report the truth
// rather than an endless quiet loop.
export const BASE_RESTART_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000, 60_000];
export const BASE_RESTART_MAX = BASE_RESTART_BACKOFF_MS.length;

export function worktreePath(branch) {
  return path.join(WORKTREES, branch);
}
export function clonePath(branch) {
  return path.join(CLONES, branch);
}
