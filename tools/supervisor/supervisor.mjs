#!/usr/bin/env node
// BrowserOS Supervisor — the stable control plane for live version control
// (specs/005-self-modification/spec.md, run-model A).
//
// It owns the PUBLIC port and reverse-proxies to internal `next start` instances:
//  - BASE: the current promoted code, ALWAYS running on BASE_PORT.
//  - PREVIEW: at most one feature branch being viewed, on a port drawn from a pool
//    above BASE_PORT. Previews live in branch-named worktrees so the bookkeeping
//    survives restarts and a branch can be resumed after a Stop.
// It serves the version-independent /__supervisor control surface so the running
// OS can be swapped safely.
//
// Standalone & dependency-light (Node built-ins only): the Supervisor is the
// trusted kernel and is NOT itself self-modified. Run: `npm run supervisor`.

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LogStore } from "./log-store.mjs";

const exec = promisify(execFile);

// ---------------------------------------------------------------- config
const REPO = process.env.BOS_REPO || process.cwd();
const PUBLIC_PORT = Number(process.env.BOS_PUBLIC_PORT || 8080);
const BASE_PORT = Number(process.env.BOS_PORT_BASE || 3000);
// Number of preview ports available ABOVE the base port: BASE_PORT+1 .. BASE_PORT+POOL_SIZE.
const POOL_SIZE = Number(process.env.BOS_PORT_POOL_SIZE || 20);
let baseBranch = process.env.BOS_BASE_BRANCH || "";             // resolved to REPO's current branch at startup
const WORKTREES = process.env.BOS_WORKTREES || path.join(REPO, "bos-worktrees");
const CANONICAL_DATA = process.env.BOS_CANONICAL_DATA || path.join(REPO, "data");
const CLONES = process.env.BOS_DATA_CLONES || path.join(REPO, "bos-data-clones");
const PUSH_MODE = process.env.BOS_PUSH_MODE || "manual";        // manual | auto-on-promote
const REMOTE = process.env.BOS_REMOTE || "origin";
const HEALTH_TIMEOUT_MS = Number(process.env.BOS_HEALTH_TIMEOUT_MS || 120_000);
// Reuse an already-running server as BASE (dev convenience / testing).
const REUSE_BASE_PORT = process.env.BOS_ACTIVE_REUSE_PORT ? Number(process.env.BOS_ACTIVE_REUSE_PORT) : null;
// How often to poll the Next.js server's /api/gitfs/reconcile job status
// during a promote's reconciliation (001-external-repo-integration, US6).
const RECONCILE_POLL_MS = Number(process.env.BOS_RECONCILE_POLL_MS || 2_000);
// Supervisor-OWNED dev base: the Supervisor spawns `next dev` for base itself
// (single-process model — just start the Supervisor). Because it owns the process
// it can npm-install + restart base on promote, with HMR during development.
const BASE_DEV = /^(1|true|yes)$/i.test(process.env.BOS_BASE_DEV || "");
const PIN_COOKIE = "bos_pin";

// Items content repo (GitFS) — dataDir()/user-apps, the user's local
// marketplace and the ONE install target for every item (apps included; there
// is no separate apps repo). App candidates are git BRANCHES here (not
// worktrees + a second server): the base BOS serves this repo's working tree,
// so checking out the candidate branch makes the in-progress app visible
// ("branch-live" preview), promote merges it to the base branch, discard drops
// it. Orthogonal to the BOS-code preview flow above and needs no extra
// port/proxy.
const APPS_REPO = path.join(CANONICAL_DATA, "user-apps");
// Container of external spec stores (018/020). Each store is mounted into a
// preview worktree at `specs/<store>/` as a GIT WORKTREE of that store, checked
// out on the SAME feature branch as the code (020-branch-coupled-specs) — one
// feature = one branch name across the BOS repo and every store. Promote merges
// both; discard drops both.
// 027 relocated the store container from <repo>/specs to <canonicalData>/specs so
// the canonical stores live in the base data volume (matching the base app's
// specsRoot() = <dataDir>/specs). Previews still get BOS_SPECS_ROOT=<worktree>/specs
// (the branch-coupled worktree mounts), so coupling is unchanged.
const SPECS_ROOT = process.env.BOS_SPECS_ROOT || path.join(CANONICAL_DATA, "specs");
const APP_CANDIDATE_BRANCH = "app-candidate";
const GIT_IDENTITY = ["-c", "user.name=BrowserOS", "-c", "user.email=bos@localhost"];
/** @type {{branch:string, base:string}|null} */
let appCandidate = null;

// Central log store (specs/017-central-logging). The Supervisor is the SINGLE writer
// and always-on sink: frontend + version-server backends ship records here too.
const logStore = new LogStore(CANONICAL_DATA);

// console + persist. log() mirrors every supervisor message into the store (supervisor
// stream); slog() adds structured fields (branch, versionLabel, err, buildLog, …).
const log = (...a) => {
  console.log("[supervisor]", ...a);
  try { logStore.write({ level: "info", stream: "supervisor", component: "supervisor", msg: a.map(String).join(" ") }, { versionLabel: "supervisor" }); } catch { /* never fail on logging */ }
};
const slog = (level, component, msg, extra = {}) => {
  console.log("[supervisor]", msg);
  try { logStore.write({ level, stream: "supervisor", component, msg, ...extra }, { versionLabel: "supervisor" }); } catch { /* never fail on logging */ }
};

// ---------------------------------------------------------------- version registry
// Only two roles: the always-on BASE (a singleton, a detached worktree at the base
// commit so it never conflicts with REPO's own checkout of baseBranch) and zero or
// more PREVIEWs (feature branches in branch-named worktrees), keyed by branch name.
/** @typedef {{role:string,branch?:string,worktree?:string,dataDir?:string,port:number,state:string,proc?:import('node:child_process').ChildProcess|null,commit?:string,reused?:boolean,dev?:boolean,expectingExit?:boolean}} Version */
/** @type {Version|null} */ let base = null;
/** @type {Map<string, Version>} */ const previews = new Map(); // branch → preview

/** @typedef {Version & {branch:string}} Preview */

function worktreePath(branch) { return path.join(WORKTREES, branch); }
function clonePath(branch) { return path.join(CLONES, branch); }
const FEATURE_BRANCH_PREFIX = "bos/";
const FEATURE_BRANCH_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,3}$/;
function isFeatureBranch(branch) {
  if (typeof branch !== "string" || !branch.startsWith(FEATURE_BRANCH_PREFIX) || branch === baseBranch) return false;
  return FEATURE_BRANCH_SLUG.test(branch.slice(FEATURE_BRANCH_PREFIX.length));
}
function requireFeatureBranch(branch) {
  if (!isFeatureBranch(branch)) {
    throw new Error(`feature branch must match ${FEATURE_BRANCH_PREFIX}<kebab-name> with 1-4 lowercase dash-separated segments`);
  }
  return branch;
}
function tagStamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}_${z(d.getMinutes())}_${z(d.getSeconds())}`;
}

// Lowest free preview port in (BASE_PORT, BASE_PORT+POOL_SIZE]. Skips ports held by
// a tracked version or anything foreign already listening (probe-before-bind).
async function allocPreviewPort() {
  const used = new Set();
  if (base?.port) used.add(base.port);
  for (const p of previews.values()) if (p.port) used.add(p.port);
  for (let p = BASE_PORT + 1; p <= BASE_PORT + POOL_SIZE; p++) {
    if (used.has(p)) continue;
    if (await probeOnce(p)) continue;
    return p;
  }
  throw new Error(`no free preview port in pool ${BASE_PORT + 1}-${BASE_PORT + POOL_SIZE}`);
}

// Resolve a version's branch live from its working dir so renames/merges are
// reflected rather than the value captured at registration.
async function liveBranch(v) {
  if (!v) return undefined;
  const b = await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], ignoreGitError, v.worktree || REPO);
  // The BASE runs from a DETACHED worktree (detached at its commit so the branch
  // ref stays free for promote/merge), where `rev-parse --abbrev-ref HEAD` yields
  // the literal "HEAD". Fall back to the version's logical branch (base →
  // baseBranch) so the toolbar shows/selects the real branch, not "HEAD" — which
  // otherwise makes base look like a feature selection and leaves the preview
  // buttons active.
  return b && b !== "HEAD" ? b : v.branch || undefined;
}
async function publicState() {
  const pick = async (v) =>
    v ? { role: v.role, branch: await liveBranch(v), port: v.port, state: v.state, commit: v.commit, reused: !!v.reused, ...(v.buildError ? { buildError: v.buildError } : {}), ...(v.buildLog ? { buildLog: v.buildLog } : {}), ...(v.devopsConversationId ? { devopsConversationId: v.devopsConversationId } : {}) } : null;
  const b = await pick(base);
  const ps = await Promise.all([...previews.values()].map(pick));
  return { base: b, previews: ps, appCandidate, pushMode: PUSH_MODE, baseBranch };
}

// On startup, scan git for bos/* feature branches and re-provision their
// worktrees. Runtime state is intentionally not persisted: restored previews are
// treated as not-built and can be rebuilt or resumed explicitly.
async function restorePreviews() {
  const raw = (await gitTry(["branch", "--list", `${FEATURE_BRANCH_PREFIX}*`, "--format=%(refname:short)"], ignoreGitError)) || "";
  const branches = raw.split("\n").map((s) => s.trim()).filter((s) => s && s !== "HEAD");
  if (!branches.length) return;
  for (const branch of branches) {
    if (!isFeatureBranch(branch)) continue;
    // Skip if already in the map (e.g. provisioned during this run).
    if (previews.has(branch)) continue;
    try {
      const wt = await addWorktreeForBranch(branch);
      await mountSpecStores(wt, branch).catch((e) => slog("warn", "restore", `spec mount failed for ${branch}: ${e?.message || e}`, { branch }));
      const clone = clonePath(branch);
      await provisionClone(clone);
      await mountUserApps(clone, branch).catch((e) => slog("warn", "restore", `user-apps mount failed for ${branch}: ${e?.message || e}`, { branch }));
      await linkUserAppsIntoWorktree(wt, clone).catch((e) => slog("warn", "restore", `user-apps worktree link failed for ${branch}: ${e?.message || e}`, { branch }));
      const port = await allocPreviewPort();
      const p = { role: "preview", branch, worktree: wt, dataDir: clone, port, state: "not-built", proc: null, commit: await gitTry(["rev-parse", "HEAD"], ignoreGitError, wt) };
      previews.set(branch, p);
      log(`restored preview ${branch} (not-built) on port ${port}`);
    } catch (e) {
      slog("warn", "restore", `failed to restore preview ${branch}: ${e.message || e}`, {});
    }
  }
  if (previews.size) log(`restored ${previews.size} preview(s) from git branches`);
}

// ---------------------------------------------------------------- git
async function git(args, cwd = REPO) {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
// gitTry NEVER swallows a failure silently: every failure is logged
// unconditionally, and the caller MUST pass an onError handler — even if
// that handler is the shared `ignoreGitError` no-op below — so choosing not
// to react further is always an explicit, visible decision at the call site,
// not a default nobody had to opt into. The handler runs AFTER the log line,
// never before.
async function gitTry(args, onError, cwd = REPO) {
  if (typeof onError !== "function") {
    throw new TypeError(`gitTry(${JSON.stringify(args)}): onError handler is mandatory`);
  }
  try {
    return await git(args, cwd);
  } catch (e) {
    const msg = e?.message || String(e);
    slog("warn", "git", `git ${args.join(" ")} failed (cwd=${cwd}): ${msg}`, { cwd, args });
    onError(e);
    return null;
  }
}

// Shared handler for call sites where a failure is expected/benign (probing
// whether a branch/worktree/ref exists, best-effort cleanup of something that
// may already be gone, etc.) — gitTry's own log line above is the full record;
// this just declares "no further reaction needed" explicitly.
const ignoreGitError = () => {};

// Shared handler for call sites where a failed read must NOT be silently
// treated as "empty"/"clean" and used to make a safety-relevant decision
// (e.g. a failed `git status` must never be conflated with "nothing to
// report"). Re-throws after gitTry's log line, turning gitTry back into a
// normal throwing call for that one invocation.
const rethrowGitError = (e) => { throw e; };

// npm install (run on every container start by docker-entrypoint.sh, and again
// after a promote whose deps changed — see depsChanged below) can legitimately
// touch package-lock.json — platform-specific optional-dependency entries
// differ by OS/arch, and npm may reformat it. That is expected provisioning
// behavior, not an agent editing the live checkout, so it alone must never
// count as "dirty" for any safety/pre-flight check. Shared by
// assertRepoIntegrity (post-condition gate) and promote (pre-flight gate) so
// both treat lockfile-only drift identically.
function meaningfulDirtyLines(dirty) {
  return (dirty || "")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().endsWith("package-lock.json"));
}

// Post-condition safety gate: verify the live checkout (REPO) is still on the
// expected base branch and has no uncommitted changes. If either invariant is
// violated we log a loud ERROR and attempt a safe restore (checkout baseBranch +
// reset --hard) so the running base is never left in a dirty/wrong-branch state.
// Returns true when a violation was detected. Callers must fail the candidate:
// restoring the live checkout means the agent edited the wrong tree, so reporting
// a successful preview would be misleading.
async function assertRepoIntegrity(context = "") {
  try {
    const branch = await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], ignoreGitError);
    const dirty = await gitTry(["status", "--porcelain"], ignoreGitError);
    const meaningfulDirty = meaningfulDirtyLines(dirty);
    const violated = branch !== baseBranch || meaningfulDirty.length > 0;
    if (!violated) return false; // fast path — everything is fine

    const msg =
      `SAFETY GATE VIOLATED${context ? ` (${context})` : ""}: ` +
      `REPO branch="${branch}" (expected "${baseBranch}"), dirty="${dirty || ""}". ` +
      `Something edited or branched the live checkout instead of the isolated preview worktree. ` +
      `Attempting safe restore.`;
    slog("error", "safety-gate", msg, { branch, baseBranch, dirty: dirty || "" });

    // Attempt restore: switch back to baseBranch and discard any uncommitted changes.
    if (branch !== baseBranch) {
      await gitTry(["checkout", baseBranch], ignoreGitError).catch(() => {});
    }
    if (dirty) {
      await gitTry(["reset", "--hard", "HEAD"], ignoreGitError).catch(() => {});
      await gitTry(["clean", "-fd"], ignoreGitError).catch(() => {});
    }

    const afterBranch = await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], ignoreGitError);
    const afterDirty = await gitTry(["status", "--porcelain"], ignoreGitError);
    slog("warn", "safety-gate", `restore complete: branch="${afterBranch}", dirty="${afterDirty || ""}"`);
    return true;
  } catch (e) {
    slog("error", "safety-gate", `assertRepoIntegrity check itself failed: ${e.message || e}`);
    return true;
  }
}

// ---------------------------------------------------------------- data clone (reads the datafs setting)
async function isolationMethod() {
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(CANONICAL_DATA, "config", "datafs.json"), "utf8"));
    return cfg.method || "auto";
  } catch {
    return "auto";
  }
}
async function provisionClone(target) {
  // Idempotent: a preview's data-clone persists across Supervisor restarts
  // (it lives on a bind-mounted host directory in the bastion deployment, or
  // just on disk standalone). If it already exists, it may hold data drift
  // from the preview's own testing — never blow it away just because the
  // Supervisor restarted; only a genuinely missing clone gets (re-)provisioned.
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
// node_modules into the worktree. Use copy-on-write (--reflink=auto): cheap on
// filesystems that support it (btrfs/XFS/APFS) and a full copy elsewhere. NOT a
// hardlink farm — hardlinks share inodes with the running base and every other
// worktree, so an in-place npm/postinstall/patch write to an EXISTING
// node_modules file would bleed across trees and could corrupt the live base at
// runtime. CoW breaks the share on first write, so a preview's dependency change
// stays isolated. Also carry env secrets (also gitignored).
async function hydrateWorktree(wt) {
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

// ---------------------------------------------------------------- spec stores (020-branch-coupled-specs)
// Every spec store (a git repo at SPECS_ROOT/<store>) is mounted into the code
// worktree at `specs/<store>/` as a GIT WORKTREE of the store, checked out on the
// code's feature branch. Real directories, so Turbopack never sees a symlink; new
// files propagate through commits (shared object DB + refs), so the canonical
// store sees spec work as soon as it is committed. The BOS repo gitignores
// `specs/`, so `git add -A` in the code worktree never stages the mounts.

// A store = a subdirectory of SPECS_ROOT with its own `.git` and a manifest
// (same discovery rule as src/lib/specs/stores.ts — never the container itself).
async function listSpecStores() {
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
      stores.push({ id: e.name, root });
    } catch {
      /* not a store */
    }
  }
  return stores;
}

// The store's default branch = whatever its canonical checkout is on (stores are
// kept on their default branch; feature work lives in the mounted worktrees).
async function storeDefaultBranch(root) {
  return (await gitTry(["symbolic-ref", "--short", "HEAD"], ignoreGitError, root)) || "master";
}

// Mount (or refresh) the store worktrees for `branch` at `wt/specs/<store>`.
// Replaces a legacy symlink from the pre-020 design. Reuses an intact existing
// mount; otherwise prunes stale registrations and adds the worktree — on the
// existing store branch, or a new one off the store's default.
async function mountSpecStores(wt, branch) {
  const container = path.join(wt, "specs");
  const legacy = await fs.lstat(container).catch(() => null);
  if (legacy?.isSymbolicLink()) await fs.rm(container, { force: true });
  const stores = await listSpecStores();
  if (!stores.length) return;
  await fs.mkdir(container, { recursive: true });
  for (const s of stores) {
    const dst = path.join(container, s.id);
    const mounted = await fs.access(path.join(dst, ".git")).then(() => true).catch(() => false);
    if (mounted && (await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], ignoreGitError, dst)) === branch) continue;
    await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
    await gitTry(["worktree", "prune"], ignoreGitError, s.root);
    if (await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`], ignoreGitError, s.root)) {
      await git(["worktree", "add", dst, branch], s.root);
    } else {
      await git(["worktree", "add", "-b", branch, dst, await storeDefaultBranch(s.root)], s.root);
    }
  }
}

// Commit spec edits in every mounted store worktree (mirrors the code-worktree
// commit in buildAndStart): spec work must be on the store's refs — visible from
// base, safe from a worktree teardown — before we build or promote.
async function commitSpecStores(wt, branch) {
  for (const s of await listSpecStores()) {
    const dst = path.join(wt, "specs", s.id);
    if (!(await fs.access(path.join(dst, ".git")).then(() => true).catch(() => false))) continue;
    await gitTry(["add", "-A"], ignoreGitError, dst);
    // Skip the commit attempt entirely when there's nothing staged — Build
    // Studio already commits spec edits on save, so by promote time this is
    // usually already clean. Committing anyway would just fail with "nothing
    // to commit" every time, and gitTry logs every git failure unconditionally
    // (by design), so that "expected" failure would show up as a spurious
    // warning on nearly every promote.
    const dirty = await gitTry(["status", "--porcelain"], ignoreGitError, dst);
    if (!dirty) continue;
    await gitTry([...GIT_IDENTITY, "commit", "-m", `spec candidate (${branch})`], ignoreGitError, dst);
  }
}

// Pre-check: can every store's feature branch merge cleanly into its default?
// Returns null when clean, else a description. Run BEFORE the code promote's
// point of no return so a spec conflict never strands a half-promoted feature.
async function specStoreConflicts(branch) {
  for (const s of await listSpecStores()) {
    if (!(await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`], ignoreGitError, s.root))) continue;
    const base = await storeDefaultBranch(s.root);
    const mb = await gitTry(["merge-base", base, branch], ignoreGitError, s.root);
    if (!mb) continue;
    try {
      await exec("git", ["merge-tree", "--write-tree", `--merge-base=${mb}`, base, branch], { cwd: s.root, maxBuffer: 8 * 1024 * 1024 });
    } catch (e) {
      const out = `${String(e.stdout || "")}\n${String(e.stderr || "")}`.trim();
      return `spec store "${s.id}": branch ${branch} conflicts with ${base}:\n${out || "(merge conflicts)"}`;
    }
  }
  return null;
}

// Remove a store's worktree registration for `dst` (dir may already be gone).
async function removeStoreWorktree(root, dst) {
  await gitTry(["worktree", "remove", "--force", dst], ignoreGitError, root);
  await gitTry(["worktree", "prune"], ignoreGitError, root);
}

// Merge each store's feature branch into its default (build-free — specs are
// inert content), then drop the branch + its worktree registration. Called after
// the code promote succeeds. A failure here is logged loudly and leaves the
// branch for manual merge — it must not roll back an already-promoted base.
async function promoteSpecStores(branch, wt) {
  for (const s of await listSpecStores()) {
    if (!(await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`], ignoreGitError, s.root))) continue;
    await removeStoreWorktree(s.root, path.join(wt, "specs", s.id));
    try {
      await git([...GIT_IDENTITY, "merge", "--no-edit", branch], s.root);
      await gitTry(["branch", "-D", branch], ignoreGitError, s.root);
      slog("info", "promote", `spec store ${s.id}: merged ${branch}`, { branch });
    } catch (e) {
      await gitTry(["merge", "--abort"], ignoreGitError, s.root);
      slog("error", "promote", `spec store ${s.id}: merge of ${branch} FAILED after code promote — merge manually in ${s.root}: ${e?.message || e}`, { branch });
    }
  }
}

// Drop the store feature branches + worktree registrations (Discard). Committed
// canonical history is untouched; uncommitted worktree edits die with the
// worktree, same as code.
async function discardSpecStores(branch, wt) {
  for (const s of await listSpecStores()) {
    if (wt) await removeStoreWorktree(s.root, path.join(wt, "specs", s.id));
    else await gitTry(["worktree", "prune"], ignoreGitError, s.root);
    await gitTry(["branch", "-D", branch], ignoreGitError, s.root);
  }
}

// ---------------------------------------------------------------- user-apps (branch-coupled data)
// dataDir()/user-apps (APPS_REPO) is the user's local marketplace — a real
// GitFS repo (src/lib/gitfs/store.ts), not ephemeral runtime state. A preview's
// blanket data clone (provisionClone) would otherwise leave it a disconnected,
// un-branched hardlink snapshot of whatever APPS_REPO's working tree looked
// like at clone time — exactly the gap that silently destroyed a marketplace
// app built during a feature-branch preview (Promote is code-only; the data
// clone, including anything written under user-apps/, is discarded once the
// code merges). Mount it the same way spec stores are (020-branch-coupled-
// specs): a real git worktree of APPS_REPO on the SAME feature branch. Unlike
// specs it's placed AT `<dataDir>/user-apps`, not inside the code worktree —
// nothing overrides where user-apps lives, dataDir()/user-apps already always
// resolves there, so this needs zero changes anywhere in src/.
//
// Unlike a spec store, APPS_REPO's OWN primary checkout (CANONICAL_DATA/user-apps,
// what BASE actually serves user-apps/ from) is NOT always on its default
// branch: the pre-existing bare-BASE app-candidate flow (appBegin/appPromote/
// appDiscard, further below) checks it out onto APP_CANDIDATE_BRANCH in place.
// promoteUserApps accounts for that below.

/** The branch APPS_REPO's primary checkout should be considered "based on",
 *  even if it's currently sitting on APP_CANDIDATE_BRANCH mid a bare-BASE draft. */
async function userAppsBaseBranch() {
  const cur = await gitTry(["symbolic-ref", "--short", "HEAD"], ignoreGitError, APPS_REPO);
  if (cur && cur !== APP_CANDIDATE_BRANCH) return cur;
  return appCandidate?.base || "master";
}

// Mount (or refresh) the user-apps worktree for `branch` at `<dataDir>/user-apps`.
// Reuses an intact existing mount; otherwise prunes stale registrations and adds
// the worktree — on the existing app-content branch, or a new one off the
// current true base. Mirrors mountSpecStores.
async function mountUserApps(dataDir, branch) {
  await ensureAppsRepo();
  const dst = path.join(dataDir, "user-apps");
  const mounted = await fs.access(path.join(dst, ".git")).then(() => true).catch(() => false);
  if (mounted && (await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], ignoreGitError, dst)) === branch) return;
  await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
  await gitTry(["worktree", "prune"], ignoreGitError, APPS_REPO);
  if (await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`], ignoreGitError, APPS_REPO)) {
    await git(["worktree", "add", dst, branch], APPS_REPO);
  } else {
    await git(["worktree", "add", "-b", branch, dst, await userAppsBaseBranch()], APPS_REPO);
  }
}

/**
 * Symlink the CODE worktree's own `data/user-apps` at the properly
 * branch-coupled worktree mountUserApps just (re)mounted. Without this, a
 * developer sub-agent — which only ever operates inside its worktree, and has
 * no reason to know about BOS_DATA_CLONES or any running server's API — will
 * naturally reach for the path that looks right, `data/user-apps/items/<id>/`,
 * relative to its own working directory. That path is otherwise a plain,
 * gitignored, disconnected directory: never read by any running server, never
 * git-tracked, and wiped the moment the worktree is torn down (`git worktree
 * remove`) — which is exactly how a marketplace app built this way is
 * silently lost on promote/discard, even with user-apps itself now correctly
 * branch-coupled.
 *
 * With the symlink in place, writing to that natural relative path IS writing
 * into the same git worktree the running preview server, promoteUserApps, and
 * discardUserApps all use — no special-cased path or API call required.
 * Idempotent; safe to call on every mount.
 */
async function linkUserAppsIntoWorktree(wt, dataDir) {
  const dst = path.join(wt, "data", "user-apps");
  const target = path.join(dataDir, "user-apps");
  const existing = await fs.lstat(dst).catch(() => null);
  if (existing?.isSymbolicLink() && (await fs.readlink(dst).catch(() => null)) === target) return;
  if (existing) await fs.rm(dst, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.symlink(target, dst, "dir");
}

// Commit any pending app-content edits in the mounted worktree (mirrors
// commitSpecStores). installApp() already commits after every write, so this
// is a safety net for anything that bypassed that, not the primary path.
async function commitUserApps(dataDir, branch) {
  const dst = path.join(dataDir, "user-apps");
  if (!(await fs.access(path.join(dst, ".git")).then(() => true).catch(() => false))) return;
  await gitTry(["add", "-A"], ignoreGitError, dst);
  // Skip the commit attempt entirely when there's nothing staged — installApp()
  // already commits after every write, so by promote time this is usually
  // already clean. See commitSpecStores for why an unconditional commit here
  // would otherwise show up as a spurious warning on nearly every promote.
  const dirty = await gitTry(["status", "--porcelain"], ignoreGitError, dst);
  if (!dirty) return;
  await gitTry([...GIT_IDENTITY, "commit", "-m", `app content candidate (${branch})`], ignoreGitError, dst);
}

// Pre-check: can `branch` merge cleanly into user-apps' true base? Mirrors
// specStoreConflicts — run BEFORE the code promote's point of no return, so an
// app-content conflict blocks the whole promote rather than stranding it.
async function userAppsConflicts(branch) {
  if (!(await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`], ignoreGitError, APPS_REPO))) return null;
  const base = await userAppsBaseBranch();
  const mb = await gitTry(["merge-base", base, branch], ignoreGitError, APPS_REPO);
  if (!mb) return null;
  try {
    await exec("git", ["merge-tree", "--write-tree", `--merge-base=${mb}`, base, branch], { cwd: APPS_REPO, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    const out = `${String(e.stdout || "")}\n${String(e.stderr || "")}`.trim();
    return `user-apps: branch ${branch} conflicts with ${base}:\n${out || "(merge conflicts)"}`;
  }
  return null;
}

/**
 * Merge `branch` into user-apps' true base, then drop the worktree + branch.
 * Called right after the code promote succeeds, BEFORE the preview's data
 * clone is discarded.
 *
 * APPS_REPO's primary checkout (what BASE actually serves user-apps/ from) is
 * USUALLY on its default branch, in which case merging directly there is safe
 * (same as promoteSpecStores). But it can be transiently on
 * APP_CANDIDATE_BRANCH (an unrelated bare-BASE draft in progress) — checking
 * out master there to merge would flip branches on the exact directory BASE is
 * live-serving from mid-request. So when that's the case, merge via plumbing
 * instead (merge-tree + commit-tree + update-ref): the ref advances, but the
 * working directory is never touched. BASE keeps showing the app-candidate
 * draft until it resolves; appPromote/appDiscard's own later checkout of the
 * base branch then picks up the already-advanced tip transparently.
 */
async function promoteUserApps(branch, dataDir) {
  if (!(await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`], ignoreGitError, APPS_REPO))) return;
  await removeStoreWorktree(APPS_REPO, path.join(dataDir, "user-apps"));

  const cur = await gitTry(["symbolic-ref", "--short", "HEAD"], ignoreGitError, APPS_REPO);
  try {
    if (cur && cur !== APP_CANDIDATE_BRANCH) {
      // Primary checkout is genuinely on its default branch — safe to merge in place.
      await git([...GIT_IDENTITY, "merge", "--no-edit", branch], APPS_REPO);
      slog("info", "promote", `user-apps: merged ${branch} onto ${cur}`, { branch });
    } else {
      // Primary checkout is busy (app-candidate, or detached) — merge via
      // plumbing so we never touch its working tree.
      const base = appCandidate?.base || "master";
      const baseTip = await git(["rev-parse", base], APPS_REPO);
      const branchTip = await git(["rev-parse", branch], APPS_REPO);
      const mb = await git(["merge-base", base, branch], APPS_REPO);
      const { stdout } = await exec("git", ["merge-tree", "--write-tree", `--merge-base=${mb}`, baseTip, branchTip], { cwd: APPS_REPO, maxBuffer: 8 * 1024 * 1024 });
      const treeSha = stdout.trim().split("\n")[0];
      const mergeCommit = await git([...GIT_IDENTITY, "commit-tree", treeSha, "-p", baseTip, "-p", branchTip, "-m", `app content: merge ${branch}`], APPS_REPO);
      await git(["update-ref", `refs/heads/${base}`, mergeCommit], APPS_REPO);
      slog("info", "promote", `user-apps: merged ${branch} into ${base} via plumbing (primary checkout busy on ${cur || "(detached)"})`, { branch });
    }
    await gitTry(["branch", "-D", branch], ignoreGitError, APPS_REPO);
  } catch (e) {
    await gitTry(["merge", "--abort"], ignoreGitError, APPS_REPO);
    slog("error", "promote", `user-apps: merge of ${branch} FAILED after code promote — merge manually in ${APPS_REPO}: ${e?.message || e}`, { branch });
  }
}

// Drop the app-content branch + worktree registration (Discard). Committed
// canonical history is untouched; uncommitted worktree edits die with the
// worktree, same as code.
async function discardUserApps(branch, dataDir) {
  if (dataDir) await removeStoreWorktree(APPS_REPO, path.join(dataDir, "user-apps"));
  else await gitTry(["worktree", "prune"], ignoreGitError, APPS_REPO);
  await gitTry(["branch", "-D", branch], ignoreGitError, APPS_REPO);
}

// Create/replace the BASE worktree: detached at `commit` so it never conflicts with
// REPO's own checkout of baseBranch. Fixed location (base is a singleton).
async function addBaseWorktree(commit) {
  const wt = path.join(WORKTREES, "base");
  await gitTry(["worktree", "remove", "--force", wt], ignoreGitError);
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
async function isHealthyWorktree(wt, branch) {
  if (!(await gitTry(["rev-parse", "--git-dir"], ignoreGitError, wt))) return false;
  if ((await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], ignoreGitError, wt)) !== branch) return false;
  const worktreeHead = await gitTry(["rev-parse", "HEAD"], ignoreGitError, wt);
  const branchTip = await gitTry(["rev-parse", branch], ignoreGitError);
  if (!worktreeHead || !branchTip || worktreeHead !== branchTip) return false;
  return !!(await fs.stat(path.join(wt, "node_modules")).catch(() => null));
}

// Create/replace a worktree for an EXISTING branch at WORKTREES/<branch>. Branch
// names may contain '/', kept as nested dirs (git ref rules forbid foo AND foo/bar
// at once, so no path collision); mkdir the parent.
async function addWorktreeForBranch(branch) {
  const wt = worktreePath(branch);
  if (await isHealthyWorktree(wt, branch)) return wt;
  await gitTry(["worktree", "remove", "--force", wt], ignoreGitError);
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.dirname(wt), { recursive: true });
  // Clear any stale worktree registration (e.g. a worktree dir removed by hand, or a
  // leftover lock) so `worktree add` can't fail with "already registered"/"already
  // checked out" — the failure that would otherwise push the caller into editing the
  // live checkout in place (specs/017-central-logging diagnosis).
  await gitTry(["worktree", "prune"], ignoreGitError);
  await git(["worktree", "add", wt, branch]);
  await hydrateWorktree(wt);
  return wt;
}

// ------------------------------------------------------------ process supervision
// Backoff schedule for restarting a base server that died on its own. Its length
// is also the give-up threshold: after this many CONSECUTIVE failed restarts the
// Supervisor stops trying and leaves base "failed", so /__supervisor/status and
// the bastion's health probe report the truth rather than an endless quiet loop.
const BASE_RESTART_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000, 60_000];
const BASE_RESTART_MAX = BASE_RESTART_BACKOFF_MS.length;

/** Base-server supervision counters, exposed via /__supervisor/status. */
const baseSupervision = {
  restarts: 0,
  consecutiveFailures: 0,
  /** @type {{code:number|null,signal:string|null,at:number,expected:boolean,oomSuspected:boolean}|null} */
  lastExit: null,
  /** @type {number|null} */ lastRestartAt: null,
  givenUp: false,
};
let baseRestarting = false;

const napMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when this exit was caused by us (Stop / promote swap / shutdown). Single-shot. */
function consumeExpectedExit(v) {
  const expected = v.expectingExit === true;
  v.expectingExit = false;
  return expected;
}

function describeExit(code, signal) {
  if (signal) return `signal ${signal}`;
  return `code ${code ?? "null"}`;
}

/**
 * Log a child server's exit with the SIGNAL included, not just the code.
 *
 * Why the signal matters: when the kernel OOM-kills `next dev`'s next-server
 * child, the parent `next dev` process exits with code 0 — so logging only the
 * code reports a clean shutdown for what was actually an out-of-memory kill.
 * That masked a real production OOM for 10 hours. A SIGKILL, or a code-0 exit
 * from a server that was healthy and serving, both get flagged here.
 */
function recordExit(v, code, signal, expected) {
  const oomSuspected = signal === "SIGKILL" || (!expected && code === 0 && v.state === "ready");
  const label = v === base ? "base" : `version "${v.role}"`;
  const detail = describeExit(code, signal);
  const suffix = oomSuspected
    ? " — SIGKILL or a clean exit from a serving process usually means the kernel OOM killer; check `dmesg` and the cgroup's memory.events oom_kill counter"
    : "";
  if (v === base) {
    baseSupervision.lastExit = { code: code ?? null, signal: signal ?? null, at: Date.now(), expected, oomSuspected };
  }
  slog(expected ? "info" : "error", "process", `${label} server exited (${detail})${expected ? ", as requested" : suffix}`, {
    branch: v.branch,
    versionLabel: v === base ? "base" : v.role,
    data: { code: code ?? null, signal: signal ?? null, expected, oomSuspected },
  });
}

/**
 * Bring base back after it died on its own.
 *
 * The Supervisor is PID 1 in the container, so when the base server dies the
 * container stays "up" while BOS is unreachable — nothing outside notices. This
 * closes that gap. It is NOT a substitute for fixing why base died: every
 * restart is logged at error level and counted in baseSupervision, which the
 * bastion's System Monitor surfaces.
 *
 * A reused external base (BOS_ACTIVE_REUSE_PORT) is the user's own process and
 * is left alone.
 */
async function restartBase(reason) {
  if (shuttingDown || baseRestarting || baseSupervision.givenUp) return;
  if (!base) return;
  if (base.reused) {
    slog("error", "process", `base (reused, external) stopped responding: ${reason} — the Supervisor cannot restart a server it does not own`, { versionLabel: "base" });
    return;
  }

  baseRestarting = true;
  try {
    while (!shuttingDown) {
      if (baseSupervision.consecutiveFailures >= BASE_RESTART_MAX) {
        baseSupervision.givenUp = true;
        base.state = "failed";
        base.buildError = `base server keeps dying (${reason}); gave up after ${baseSupervision.consecutiveFailures} restart attempts`;
        slog("error", "process", base.buildError, { versionLabel: "base", data: { restarts: baseSupervision.restarts } });
        return;
      }

      const attempt = baseSupervision.consecutiveFailures;
      await napMs(BASE_RESTART_BACKOFF_MS[attempt]);
      if (shuttingDown) return;

      baseSupervision.restarts += 1;
      baseSupervision.consecutiveFailures += 1;
      baseSupervision.lastRestartAt = Date.now();
      slog("error", "process", `base server died (${reason}) — restarting (attempt ${attempt + 1}/${BASE_RESTART_MAX})`, {
        versionLabel: "base",
        data: { attempt: attempt + 1, totalRestarts: baseSupervision.restarts },
      });

      base.state = "building";
      if (base.dev) startBaseDevProc(base);
      else startProc(base);

      if (await waitHealthy(base.port, base)) {
        base.state = "ready";
        baseSupervision.consecutiveFailures = 0;
        log(`base server restarted and healthy on :${base.port} (${baseSupervision.restarts} restart(s) total)`);
        return;
      }
      // Didn't come up — reap whatever is left and fall through to the next backoff step.
      await stopProc(base);
    }
  } finally {
    baseRestarting = false;
  }
}

function startProc(v) {
  v.proc = spawn("npx", ["next", "start", "-p", String(v.port)], {
    cwd: v.worktree,
    // BOS_CANONICAL_DATA lets a version persist cross-version state (e.g. chat
    // conversation metadata) to canonical data even when it runs on a throwaway
    // preview clone, so it survives Stop/promote.
    // Explicit spec root per role (020): previews read/write their own mounted
    // store worktrees (feature branch); base reads the canonical stores. Previews
    // must not seed stores — a seed commit would land on the feature branch.
    env: {
      ...process.env,
      PORT: String(v.port),
      BOS_DATA_DIR: v.dataDir,
      BOS_CANONICAL_DATA: CANONICAL_DATA,
      BOS_VERSION_LABEL: v.role,
      BOS_BASE_BRANCH: baseBranch,
      // EVERY server the Supervisor spawns must be supervisor-aware, exactly as
      // startBaseDevProc's is. This was missing here, so anything served through
      // this path silently lost the whole Supervisor integration, which keys off
      // BOS_SUPERVISOR_URL: the service-WebSocket proxy path (`wsPath` in
      // /api/services/<id>/config — without it the Terminal app falls back to a
      // direct host:port the browser cannot reach, e.g. wss://host:3001),
      // supervisor-backed git (src/lib/system/git.ts), and log shipping to the
      // central store (src/lib/logging/server-logger.ts, /api/logs).
      // It went unnoticed while base ran in dev mode, because only base was in
      // production-mode's blind spot; switching base to `next start` exposed it.
      BOS_SUPERVISOR_URL: `http://127.0.0.1:${PUBLIC_PORT}`,
      BOS_SPECS_ROOT: v.role === "preview" ? path.join(v.worktree, "specs") : SPECS_ROOT,
      ...(v.role === "preview" ? { BOS_SPECS_SEED: "0" } : {}),
    },
    // Redirect Next.js stderr → supervisor stdout so Docker/Dokploy doesn't
    // classify normal request logs (which Next.js writes to stderr) as errors.
    stdio: ["inherit", "inherit", process.stdout],
    // detached: true puts the child in its own process group so stopProc can
    // kill the ENTIRE group (npx + its next-server child) via negative PID.
    // Without this, killing npx orphans the next process which keeps the port.
    detached: true,
  });
  v.proc.on("exit", (code, signal) => {
    const expected = consumeExpectedExit(v);
    recordExit(v, code, signal, expected);
    // An unexpected death of a running version must not keep routing traffic to a
    // dead port — mark it so pinnedVersion falls back to base.
    if (v.state === "ready") v.state = "stopped";
    else if (v.state === "building") {
      v.state = "failed";
      v.buildError = `preview process exited before becoming healthy (${describeExit(code, signal)})`;
    }
    if (!expected && v === base) void restartBase(describeExit(code, signal));
  });
}

// Stop a version's server and RESOLVE ONLY AFTER it has actually exited, so the
// port is free to rebind (critical when reusing the base port on promote). SIGKILL
// escalation guards against a process that ignores SIGTERM.
function stopProc(v) {
  return new Promise((resolve) => {
    const p = v?.proc;
    if (!p || p.killed || p.exitCode !== null || p.signalCode) { if (v) v.proc = null; return resolve(); }
    // Tell the exit handler this death is deliberate, so base supervision does
    // not treat a Stop / promote swap / shutdown as a crash and respawn it.
    v.expectingExit = true;
    const pid = p.pid;
    p.once("exit", () => { v.proc = null; resolve(); });
    // Kill the entire process group (negative PID) so child processes spawned by
    // npx (i.e. next-server) are also terminated. Without this, npx exits but
    // next-server is orphaned and keeps holding the port → EADDRINUSE on rebuild.
    const killGroup = (sig) => {
      try { process.kill(-pid, sig); }
      catch { try { p.kill(sig); } catch { /* already gone */ } }
    };
    killGroup("SIGTERM");
    setTimeout(() => { try { if (p.exitCode === null && !p.signalCode) killGroup("SIGKILL"); } catch { /* ignore */ } }, 5000);
  });
}

async function waitHealthy(port, v) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (v?.proc && (v.proc.exitCode !== null || v.proc.signalCode)) return false;
    if (v?.state === "failed" && v.buildError) return false;
    const ok = await new Promise((resolve) => {
      const r = http.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 4000 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => { try { resolve(JSON.parse(body).ok === true); } catch { resolve(false); } });
      });
      r.on("error", () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// Run `npm run build` in a worktree, STREAMING stdout+stderr into a build-log blob
// and keeping a tail as the failure reason. This is the fix for the "build failed
// and I couldn't see why" black box (specs/017): the real compiler output is now
// persisted and the reason is surfaced. Resolves { ok, code, reason, relPath }.
const BUILD_TIMEOUT_MS = 600_000;
function runBuild(cwd, branch) {
  return new Promise((resolve) => {
    const blob = logStore.openBuildLog(branch);
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
    const onChunk = (c) => {
      try { blob.stream.write(c); } catch { /* ignore */ }
      tail += c.toString();
      if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, BUILD_TIMEOUT_MS);
    const done = (r) => { clearTimeout(killer); blob.stream.end(); resolve(r); };
    child.on("error", (e) => done({ ok: false, code: null, reason: `failed to spawn build: ${e.message}`, relPath: blob.relPath }));
    child.on("close", (code) => {
      const reason = code === 0 ? "" : (tail.trim().split("\n").slice(-40).join("\n") || `build exited with code ${code}`);
      done({ ok: code === 0, code, reason, relPath: blob.relPath });
    });
  });
}

// Build a preview worktree (commit its edits onto the feature branch so a later
// promote can fast-forward them), (re)start it, and health-gate it. Stops any
// existing server for this version FIRST so a rebuild never collides on its port.
// On failure it sets state "failed" + stashes the reason (v.buildError) rather than
// throwing, so callers (e.g. /build) can surface WHY.
async function buildAndStart(v, ctx = {}) {
  await stopProc(v);
  // Commit spec-store worktrees FIRST (020): spec work belongs on the store's
  // refs (visible from base, teardown-safe) the moment the candidate builds.
  await commitSpecStores(v.worktree, v.branch);
  await git(["add", "-A"], v.worktree).catch(() => {});
  await git([...GIT_IDENTITY, "commit", "-m", `BOS candidate (${v.branch})`], v.worktree).catch((e) => {
    const detail = String(e?.stderr || e?.stdout || e?.message || e || "");
    if (detail && !/nothing to commit|no changes added/.test(detail))
      slog("warn", "build", `git commit failed in ${v.branch}: ${detail}`, { branch: v.branch, versionLabel: v.role });
  });
  v.commit = await git(["rev-parse", "HEAD"], v.worktree).catch(() => v.commit);
  // Safety gate: the worktree commit must never have leaked into the main checkout.
  const liveCheckoutWasTouched = await assertRepoIntegrity(`build ${v.branch}`);
  if (liveCheckoutWasTouched) {
    v.state = "failed";
    v.buildError =
      "developer harness edited the live checkout instead of the isolated preview worktree; the live checkout was restored and this candidate was not built";
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
  if (v.state === "failed") v.buildError = `health check failed: no healthy /api/health on :${v.port} within ${HEALTH_TIMEOUT_MS}ms`;
  slog(v.state === "ready" ? "info" : "error", "build", `${v.branch} -> ${v.state}`, { ...lctx, buildLog: build.relPath, ...(v.buildError ? { err: { message: v.buildError } } : {}) });
  return v.state;
}

// Build + start BASE from a detached worktree at `commit` (no commit step — base is
// not a candidate branch). Runs against canonical data. A base build failure is
// fatal at boot, so this still throws after logging the captured reason.
async function buildAndStartBase(commit) {
  const wt = await addBaseWorktree(commit);
  base = { role: "base", branch: baseBranch, worktree: wt, dataDir: CANONICAL_DATA, port: BASE_PORT, state: "building", proc: null, commit };
  const lctx = { branch: baseBranch, versionLabel: "base" };
  slog("info", "build", `building base (${baseBranch} @ ${commit.slice(0, 8)})`, lctx);
  const build = await runBuild(wt, baseBranch, lctx);
  base.buildLog = build.relPath;
  if (!build.ok) {
    base.state = "failed";
    base.buildError = build.reason;
    slog("error", "build", `base build FAILED (exit ${build.code})`, { ...lctx, buildLog: build.relPath, err: { message: build.reason } });
    throw new Error(`base build failed:\n${build.reason}`);
  }
  startProc(base);
  base.state = (await waitHealthy(BASE_PORT, base)) ? "ready" : "failed";
  slog(base.state === "ready" ? "info" : "error", "build", `base -> ${base.state}`, { ...lctx, buildLog: build.relPath });
  return base.state;
}

// Spawn (or respawn) the Supervisor-OWNED base `next dev` server on BASE_PORT from
// the live checkout (REPO). Owned → the Supervisor can stop/restart it on promote.
// It serves baseBranch with HMR; the merge on promote updates REPO and (after a
// restart) base runs the promoted code. Forwards BOS_SUPERVISOR_URL (self) so the
// base BOS is supervisor-aware, and passes through BOS_DEV_ORIGINS.
// Regenerate the built-in app registry (src/apps/_*.generated.ts) in REPO. These
// files are gitignored, so a promote's merge never carries them — after merging a
// feature that adds/removes a BUILT-IN app we must regenerate, or the app's source
// lands on base but stays unregistered (invisible). `next dev` then hot-reloads the
// regenerated .ts. Idempotent + cheap.
async function regenApps() {
  await exec("node", ["tools/gen-apps.mjs"], { cwd: REPO, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }).catch((e) =>
    slog("warn", "promote", `gen-apps failed: ${e?.message || e}`, {}),
  );
}

// Memory ceiling for the DEV base server (MB of V8 old space); 0 disables.
//
// `next dev` retains roughly 0.8 MB per request with no plateau (measured: 2.2 GB
// at boot, 7.1 GB after 4 minutes of light load, versus 130 MB / 249 MB
// steady-state for `next start`). Capping V8's old space makes Next's own dev
// memory guard fire — "⚠ Server is approaching the used memory threshold,
// restarting…" — so it recycles gracefully instead of growing until the kernel
// OOM-kills it.
//
// Two caveats, both measured:
//  - This bounds the HEAP, not total RSS. About half the footprint lives outside
//    V8's old space (other V8 spaces, code space, native/Turbopack allocations),
//    so RSS lands at roughly 2x the cap. Size it at ~half the memory you are
//    willing to give the dev server.
//  - It is a BOUND, not a fix. What retains the memory in dev is still
//    unexplained; production mode does not exhibit it at all.
const DEV_MAX_OLD_SPACE_MB = Number(process.env.BOS_DEV_MAX_OLD_SPACE_MB ?? 2048);

function startBaseDevProc(v) {
  // Append rather than replace, so an operator-supplied NODE_OPTIONS survives.
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    DEV_MAX_OLD_SPACE_MB > 0 ? `--max-old-space-size=${DEV_MAX_OLD_SPACE_MB}` : "",
  ].filter(Boolean).join(" ");
  if (DEV_MAX_OLD_SPACE_MB > 0) {
    log(`base dev server memory ceiling: --max-old-space-size=${DEV_MAX_OLD_SPACE_MB} (expect RSS ~${DEV_MAX_OLD_SPACE_MB * 2} MB; Next recycles the server at the threshold)`);
  }
  // Run via `npm run dev` (not `npx next dev`) so the `predev` hook regenerates the
  // built-in app registry on every start/restart. Pass the port after `--`.
  v.proc = spawn("npm", ["run", "dev", "--", "-p", String(v.port)], {
    cwd: REPO,
    env: {
      ...process.env,
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      PORT: String(v.port),
      BOS_DATA_DIR: CANONICAL_DATA,
      BOS_CANONICAL_DATA: CANONICAL_DATA,
      BOS_VERSION_LABEL: "base",
      BOS_BASE_BRANCH: baseBranch,
      BOS_SPECS_ROOT: SPECS_ROOT,
      BOS_SUPERVISOR_URL: `http://127.0.0.1:${PUBLIC_PORT}`,
    },
    // Redirect Next.js stderr → supervisor stdout so Docker/Dokploy doesn't
    // classify normal request logs (which Next.js writes to stderr) as errors.
    stdio: ["inherit", "inherit", process.stdout],
    detached: true,
  });
  v.proc.on("exit", (code, signal) => {
    const expected = consumeExpectedExit(v);
    recordExit(v, code, signal, expected);
    if (v.state === "ready") v.state = "stopped";
    if (!expected) void restartBase(describeExit(code, signal));
  });
}

// Start base as a Supervisor-owned `next dev` process (single-process model).
async function buildAndStartBaseDev() {
  const commit = await gitTry(["rev-parse", "HEAD"], ignoreGitError);
  base = { role: "base", branch: baseBranch, worktree: REPO, dataDir: CANONICAL_DATA, port: BASE_PORT, state: "building", proc: null, commit, dev: true };
  slog("info", "build", `starting owned base dev server (${baseBranch}) on :${BASE_PORT}`, { branch: baseBranch, versionLabel: "base" });
  startBaseDevProc(base);
  base.state = (await waitHealthy(BASE_PORT, base)) ? "ready" : "failed";
  if (base.state !== "ready") throw new Error(`base dev server failed to become healthy on :${BASE_PORT}`);
  log(`owned base dev server ready on :${BASE_PORT} (branch ${baseBranch})`);
  return base.state;
}

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
// function's own poll loop, running inside the SAME still-executing promote()
// call, is what makes the wait survive a browser refresh: nothing about it is
// tied to the original /control/promote HTTP connection.
async function reconcileViaApi(opts, onEscalate) {
  const start = await postJson("/api/gitfs/reconcile", opts);
  if (start.status !== 200 || !start.body?.jobId) {
    throw new Error(`reconcile job failed to start: ${JSON.stringify(start.body)}`);
  }
  const jobId = start.body.jobId;
  slog("info", "promote", `reconcile job started (${opts.repoPath})`, { branch: baseBranch, versionLabel: "base", data: { jobId } });

  let sawEscalation = false;
  for (;;) {
    const poll = await getJson(`/api/gitfs/reconcile?jobId=${encodeURIComponent(jobId)}`);
    if (poll.status !== 200) {
      throw new Error(`reconcile job poll failed: ${JSON.stringify(poll.body)}`);
    }
    const { phase, devopsConversationId, outcome } = poll.body;
    if (phase === "escalated" && !sawEscalation) {
      sawEscalation = true;
      slog("warn", "promote", `reconcile job escalated to DevOps Agent (${opts.repoPath})`, {
        branch: baseBranch,
        versionLabel: "base",
        data: { jobId, devopsConversationId },
      });
      onEscalate?.(devopsConversationId);
    }
    if (phase === "done") {
      slog("info", "promote", `reconcile job done (${opts.repoPath}): ${outcome.status}${outcome.method ? ` via ${outcome.method}` : ""}`, {
        branch: baseBranch,
        versionLabel: "base",
        data: { jobId, outcome },
      });
      return outcome;
    }
    await sleep(RECONCILE_POLL_MS);
  }
}

// ---------------------------------------------------------------- operations
// Provision a PREVIEW for `branch`: branch-named worktree + data clone + a pooled
// port. An existing branch is checked out with its committed history; a missing
// branch is created off base. Does NOT build — the developer agent edits the
// worktree, then /build runs.
async function provisionPreview(branch) {
  requireFeatureBranch(branch);
  const existing = previews.get(branch);
  if (existing) return existing;
  const exists = await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`], ignoreGitError);
  if (!exists) {
    const from = base?.commit || (await git(["rev-parse", "HEAD"]));
    await git(["branch", branch, from]);
  }
  const wt = await addWorktreeForBranch(branch);
  const clone = clonePath(branch);
  await provisionClone(clone);
  await mountUserApps(clone, branch);
  await linkUserAppsIntoWorktree(wt, clone);
  const port = await allocPreviewPort();
  const p = { role: "preview", branch, worktree: wt, dataDir: clone, port, state: "not-built", proc: null, commit: await gitTry(["rev-parse", "HEAD"], ignoreGitError, wt) };
  previews.set(branch, p);
  log(`preview ${branch} provisioned on port ${port}`);
  return p;
}

// Stop a preview's server but KEEP the worktree, branch, and data clone.
async function stopPreview(branch) {
  requireFeatureBranch(branch);
  const p = previews.get(branch);
  if (!p) return;
  await stopProc(p);
  p.state = "stopped";
  p.proc = null;
  log(`stopped preview ${p.branch} (worktree + branch kept)`);
}

// Destroy a preview entirely: stop server, remove worktree + data clone, DELETE the
// feature branch. Only called on explicit Discard or after a successful Promote.
async function discardPreview(branch) {
  requireFeatureBranch(branch);
  const p = previews.get(branch);
  previews.delete(branch);
  if (!p) {
    await discardSpecStores(branch, null);
    await discardUserApps(branch, null);
    await gitTry(["branch", "-D", branch], ignoreGitError);
    log(`discarded preview ${branch} (branch deleted)`);
    return;
  }
  await stopProc(p);
  await discardSpecStores(branch, p.worktree);
  await discardUserApps(branch, p.dataDir);
  await gitTry(["worktree", "remove", "--force", p.worktree], ignoreGitError);
  await fs.rm(p.dataDir, { recursive: true, force: true }).catch(() => {});
  await gitTry(["branch", "-D", p.branch], ignoreGitError);
  log(`discarded preview ${p.branch} (branch deleted)`);
}

async function beginPreview(branch) {
  const p = await provisionPreview(branch);
  // (Re)mount the store worktrees on every begin — fresh provision or reuse — so
  // the harness reads/writes specs on the feature branch at `specs/<store>/…`.
  await mountSpecStores(p.worktree, branch).catch((e) => slog("warn", "begin", `spec mount failed for ${branch}: ${e?.message || e}`, { branch }));
  return p;
}

async function buildPreview(branch, ctx = {}) {
  const p = previews.get(requireFeatureBranch(branch)) || (await provisionPreview(branch));
  return await buildAndStart(p, ctx);
}

// Toolbar branch selection. Base only clears the pin. A ready preview can be pinned
// immediately. Missing/not-built/stopped previews are provisioned and built in the
// background; the current request keeps serving base until Preview pins it.
async function activate(branch, ctx = {}) {
  if (!branch || branch === baseBranch) return { base: true, state: "ready" };
  const p = await provisionPreview(branch);
  if (p.state === "ready") return { branch, state: "ready" };
  if (p.state !== "building") {
    p.state = "building";
    void buildAndStart(p, ctx).catch((e) => {
      p.state = "failed";
      p.buildError = String(e?.message || e);
      log(`activate build failed for ${p.branch}: ${p.buildError}`);
    });
  }
  return { branch, state: p.state };
}

// Promote the preview to BASE. Safe ordering: do every fallible step (rebase, build,
// off-port health-gate) while base still serves; only AFTER the new code is healthy
// on the base port do we advance the base branch ref + tag (the point of no return).
// A failure before that leaves the base branch untouched and restores the old base.
async function promote(branch) {
  const cand = previews.get(requireFeatureBranch(branch));
  if (!cand) throw new Error(`no preview to promote for ${branch}`);
  if (cand.state === "stopped" || cand.state === "not-built") {
    const state = await buildAndStart(cand);
    if (state !== "ready") throw new Error(`preview ${cand.branch} is not ready (state: ${state}).`);
  }
  if (cand.state !== "ready") throw new Error(`preview ${cand.branch} is not ready (state: ${cand.state}).`);

  // A failed status check must abort the promote, not be silently read as
  // "clean" — rethrowGitError turns this back into a normal throwing call.
  const dirty = await gitTry(["status", "--porcelain"], rethrowGitError, REPO);
  const meaningfulDirty = meaningfulDirtyLines(dirty);
  if (meaningfulDirty.length > 0) {
    throw new Error(`base checkout (${REPO}) has uncommitted changes — commit, stash, or discard them before promoting:\n${meaningfulDirty.join("\n")}`);
  }
  if (dirty) {
    // Only package-lock.json drift from a previous promote's npm install is
    // present — discard it so the upcoming fast-forward merge below isn't
    // blocked by a tracked-file conflict.
    await gitTry(["checkout", "--", "package-lock.json"], ignoreGitError, REPO);
  }

  // 020: spec work promotes WITH the code. Commit any pending store-worktree
  // edits, then pre-check the store merges — a spec conflict must fail the
  // promote before anything irreversible happens.
  await commitSpecStores(cand.worktree, cand.branch);
  const specConflicts = await specStoreConflicts(cand.branch);
  if (specConflicts) throw new Error(`promote blocked — ${specConflicts}`);

  // Same for app-content: whatever was installed under user-apps/ during this
  // preview (its own branch-coupled worktree at cand.dataDir/user-apps) must
  // merge cleanly before anything irreversible happens — this is the fix for
  // the data-loss bug where a marketplace app built during a preview vanished
  // on promote.
  await commitUserApps(cand.dataDir, cand.branch);
  const appConflicts = await userAppsConflicts(cand.branch);
  if (appConflicts) throw new Error(`promote blocked — ${appConflicts}`);

  // Verify the shared reconciliation pipeline's outcome and clear/leave the
  // preview's interim "escalated" indicator accordingly. Throws (leaving
  // cand.state="escalated" in place for timed-out/unverified cases, so the
  // UI keeps pointing at the conversation) unless the target is genuinely
  // clean and mergeable.
  async function requireReconciled(outcome, repoPath, label) {
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
      const status = await gitTry(["status", "--porcelain"], ignoreGitError, repoPath);
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

  // 1) Sync base with origin FIRST (001-external-repo-integration, US6): the
  // same shared reconciliation pipeline used for every GitFS instance (tag,
  // sync, strategy, scripted rebase fallback, DevOps Agent escalation) —
  // reduces the odds that the later push is rejected because base silently
  // drifted from origin between promotes (e.g. another environment pushed
  // independently).
  slog("info", "promote", `syncing base (${baseBranch}) with ${REMOTE} before merging ${cand.branch}`, { branch: baseBranch, versionLabel: "base" });
  const baseSync = await reconcileViaApi(
    {
      repoPath: REPO,
      remote: REMOTE,
      branch: baseBranch,
      sourceRef: `${REMOTE}/${baseBranch}`,
      strategy: "merge-squash",
      escalationContext: `Supervisor promote: syncing base branch "${baseBranch}" with "${REMOTE}" before merging feature branch "${cand.branch}" onto it.`,
    },
    (devopsConversationId) => {
      cand.state = "escalated";
      cand.devopsConversationId = devopsConversationId;
    },
  );
  await requireReconciled(baseSync, REPO, `syncing base (${baseBranch}) with ${REMOTE}`);
  slog("info", "promote", `base (${baseBranch}) synced with ${REMOTE}${baseSync.method ? ` via ${baseSync.method}` : " (already up to date)"}`, { branch: baseBranch, versionLabel: "base" });

  // 2) Make the preview a clean descendant of the now-synced base, in its own
  // worktree. FF: already ahead → nothing to do. Otherwise: squash-merge the
  // candidate's changes onto base via the same shared pipeline.
  if ((await gitTry(["merge-base", "--is-ancestor", baseBranch, "HEAD"], ignoreGitError, cand.worktree)) === null) {
    cand.state = "building";
    await stopProc(cand);
    const originalCandTip = await git(["rev-parse", "HEAD"], cand.worktree);
    await git(["reset", "--hard", baseBranch], cand.worktree);
    slog("info", "promote", `merging ${cand.branch} (${originalCandTip}) onto ${baseBranch}`, { branch: cand.branch, versionLabel: "base" });
    const merge = await reconcileViaApi(
      {
        repoPath: cand.worktree,
        sourceRef: originalCandTip,
        strategy: "merge-squash",
        featureBranchForDelegate: cand.branch,
        escalationContext: `Supervisor promote: merging feature branch "${cand.branch}" (original tip ${originalCandTip}) onto base "${baseBranch}".`,
      },
      (devopsConversationId) => {
        cand.state = "escalated";
        cand.devopsConversationId = devopsConversationId;
      },
    );
    await requireReconciled(merge, cand.worktree, `merging ${cand.branch} onto ${baseBranch}`);
    slog("info", "promote", `${cand.branch} merged onto ${baseBranch}${merge.method ? ` via ${merge.method}` : ""}`, { branch: cand.branch, versionLabel: "base" });

    cand.state = "building";
    const st = await buildAndStart(cand);
    if (st !== "ready") throw new Error(`rebuilt preview ${cand.branch} failed its health check (state: ${st}); base unchanged.`);
  }
  const newCommit = await git(["rev-parse", "HEAD"], cand.worktree);

  // LIVE-CHECKOUT BASE: base serves the live checkout (REPO), not a swappable
  // worktree — either the Supervisor-OWNED dev server (BASE_DEV) or an EXTERNAL
  // reused one (BOS_ACTIVE_REUSE_PORT). The managed swap below is wrong here (can't
  // bind the occupied base port; waitHealthy would be fooled by the running server).
  // Instead advance the base branch IN THE LIVE CHECKOUT, then make base run it:
  //   - owned dev  → npm install (if deps changed) + restart the base dev server.
  //   - reused ext → the Supervisor can't restart it; flag needsRestart.
  if (base?.dev || base?.reused) {
    const prevBaseCommit = base.commit;
    await git(["checkout", baseBranch], REPO);
    await git(["merge", "--ff-only", newCommit], REPO);
    const tag = `bos/v${tagStamp()}`;
    await git([...GIT_IDENTITY, "tag", "-a", tag, "-m", `promote ${cand.branch}`], REPO);
    const pushResults = await pushPromotedBase(REPO, baseBranch);
    base.commit = newCommit;
    // Regenerate the built-in app registry so a merged built-in app (its generated
    // manifest is gitignored, thus not in the merge) is actually registered on base.
    await regenApps();
    const changed = (prevBaseCommit ? await gitTry(["diff", "--name-only", `${prevBaseCommit}..${newCommit}`], ignoreGitError, REPO) : "") || "";
    const depsChanged = /(^|\n)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)/.test(changed);
    const configChanged = /(^|\n)(next\.config\.|tsconfig|\.env)/.test(changed);
    // Land the coupled spec branches now that the code promote is committed.
    await promoteSpecStores(cand.branch, cand.worktree);
    // Land the coupled app-content branch too, BEFORE the data clone (which is
    // what cand.dataDir/user-apps' worktree physically lives inside) is discarded.
    await promoteUserApps(cand.branch, cand.dataDir);
    // Reap the promoted preview before touching base (frees resources / the branch).
    await stopProc(cand);
    await gitTry(["worktree", "remove", "--force", cand.worktree], ignoreGitError);
    await fs.rm(cand.dataDir, { recursive: true, force: true }).catch(() => {});
    await gitTry(["branch", "-D", cand.branch], ignoreGitError);
    previews.delete(cand.branch);

    if (base.dev) {
      // Supervisor owns the base dev server → make the promote deterministic: install
      // deps when they changed, then restart base so the merged code is definitely live.
      if (depsChanged) {
        slog("info", "promote", `installing dependencies after promote (${baseBranch})`, { branch: baseBranch, versionLabel: "base" });
        await exec("npm", ["install"], { cwd: REPO, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }).catch((e) =>
          slog("warn", "promote", `npm install failed: ${e?.message || e}`, { branch: baseBranch, versionLabel: "base" }),
        );
      }
      await stopProc(base);
      base.state = "building";
      startBaseDevProc(base);
      base.state = (await waitHealthy(BASE_PORT, base)) ? "ready" : "failed";
      log(`promoted ${cand.branch} → base (owned dev, tag ${tag}); base restarted${depsChanged ? " after npm install" : ""}`);
      return { tag, branch: cand.branch, dev: true, pushResults };
    }

    // Reused external server: the Supervisor can't restart it. next dev hot-reloads
    // code edits; deps/config changes need the user to restart their dev server.
    const needsRestart = depsChanged || configChanged;
    log(`promoted ${cand.branch} → base via live checkout (reused, tag ${tag})${needsRestart ? " — DEV SERVER RESTART REQUIRED (deps/config changed)" : ""}`);
    return {
      tag,
      branch: cand.branch,
      reused: true,
      needsRestart,
      pushResults,
      ...(needsRestart
        ? { message: "Dependencies or config changed. Restart your dev server (and run npm install) so base picks up the promoted code." }
        : {}),
    };
  }

  // 2) Swap on the base port: stop old base (await exit), start the candidate's code
  //    on BASE_PORT against CANONICAL data, health-gate THERE.
  const oldBase = base;
  await stopProc(oldBase);
  const swapped = { role: "base", branch: cand.branch, worktree: cand.worktree, dataDir: CANONICAL_DATA, port: BASE_PORT, state: "building", proc: null, commit: newCommit };
  startProc(swapped);
  if (!(await waitHealthy(BASE_PORT, swapped))) {
    // Failure AFTER killing old base but BEFORE moving the base ref → restore old base.
    await stopProc(swapped);
    if (oldBase) { startProc(oldBase); await waitHealthy(oldBase.port, oldBase); base = oldBase; }
    throw new Error(`promote failed: ${cand.branch} did not become healthy on the base port; restored the previous base. The base branch was NOT moved.`);
  }

  // 3) Point of no return: fast-forward the base branch to the candidate, tag, push.
  await git(["checkout", baseBranch], REPO);
  await git(["merge", "--ff-only", newCommit], REPO);
  const tag = `bos/v${tagStamp()}`;
  await git([...GIT_IDENTITY, "tag", "-a", tag, "-m", `promote ${cand.branch}`], REPO);
  const pushResults = await pushPromotedBase(REPO, baseBranch);

  // 4) Adopt the swapped server as base. Detach its worktree off the feature branch
  //    (same commit → no file change, server keeps running) so the now-merged branch
  //    can be deleted and base isn't sitting "on" a feature branch. Clean up.
  base = swapped;
  await stopProc(cand); // the preview's pool-port server is now redundant — reap it so it doesn't leak
  // Land the coupled spec branches; this also unregisters the store worktrees
  // inside the adopted base worktree (the new base reads the canonical stores).
  await promoteSpecStores(cand.branch, swapped.worktree);
  // Land the coupled app-content branch too, BEFORE cand.dataDir (which is
  // what its user-apps worktree physically lives inside) is discarded below.
  // The adopted base now reads user-apps/ straight from CANONICAL_DATA/user-apps
  // (swapped.dataDir === CANONICAL_DATA === APPS_REPO's own primary checkout),
  // which is exactly what this merges into.
  await promoteUserApps(cand.branch, cand.dataDir);
  await gitTry(["checkout", "--detach"], ignoreGitError, swapped.worktree);
  base.branch = baseBranch;
  if (oldBase?.worktree && oldBase.worktree !== swapped.worktree) await gitTry(["worktree", "remove", "--force", oldBase.worktree], ignoreGitError);
  await fs.rm(cand.dataDir, { recursive: true, force: true }).catch(() => {});
  await gitTry(["branch", "-D", cand.branch], ignoreGitError); // merged into base; the preview is gone
  previews.delete(cand.branch);
  log(`promoted ${cand.branch} → base (tag ${tag})`);
  return { tag, branch: cand.branch, pushResults };
}

// Files changed on the preview vs the base branch. The agent's edits are COMMITTED
// in the preview worktree (buildAndStart), so the main checkout looks clean — this
// surfaces the real change so the assistant's gitStatus isn't fooled.
async function previewChanges(branch) {
  const p = branch ? previews.get(branch) : null;
  if (!p) return { ok: true, candidate: null };
  const raw = (await gitTry(["diff", "--name-status", `${baseBranch}...HEAD`], ignoreGitError, p.worktree)) || "";
  const files = raw
    ? raw.split("\n").filter(Boolean).map((l) => {
        const tab = l.indexOf("\t");
        return tab < 0 ? { status: l.trim(), path: "" } : { status: l.slice(0, tab).trim(), path: l.slice(tab + 1) };
      })
    : [];
  return { ok: true, candidate: { branch: await liveBranch(p), base: baseBranch, state: p.state, commit: p.commit, files } };
}

// All git branches for the toolbar dropdown (including bos/* feature branches, so an
// orphaned preview from a previous run can be re-selected). Base is always present.
async function listBranches() {
  const raw = (await gitTry(["branch", "--format=%(refname:short)"], ignoreGitError)) || "";
  const branches = raw.split("\n").map((s) => s.trim()).filter((s) => s && s !== "HEAD");
  if (!branches.includes(baseBranch)) branches.unshift(baseBranch);
  return branches;
}

// On startup, remove the Supervisor's own leftover worktrees from a previous run
// (their processes died with the old supervisor). The BRANCHES survive, so an
// orphaned preview stays selectable from the dropdown — this just prevents
// `git worktree add` collisions and stale-port confusion.
async function reconcileWorktrees() {
  await gitTry(["worktree", "prune"], ignoreGitError);
  // Store worktrees lived inside the removed code worktrees — drop their stale
  // registrations so a later mount/branch-delete can't fail on them (020).
  for (const s of await listSpecStores()) await gitTry(["worktree", "prune"], ignoreGitError, s.root);
  const list = (await gitTry(["worktree", "list", "--porcelain"], ignoreGitError)) || "";
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length).trim();
    if (wt && wt !== REPO && wt.startsWith(WORKTREES)) {
      await gitTry(["worktree", "remove", "--force", wt], ignoreGitError);
      await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
    }
  }
  await gitTry(["worktree", "prune"], ignoreGitError);
}

// On supervisor restart any previously-spawned preview servers may still be
// listening on their pool ports (e.g. when the supervisor was SIGKILL'd). We
// probe each preview port and, for any that responds, find the owning PID via
// `ss -tlnp` (Linux) and send it SIGTERM (escalating to SIGKILL after 5 s).
// Ports that don't respond are already free — nothing to do.
// BASE_PORT itself is NOT touched here; buildAndStartBase will start fresh there.
async function reapOrphanedPreviewServers() {
  const reaped = [];
  for (let p = BASE_PORT + 1; p <= BASE_PORT + POOL_SIZE; p++) {
    if (!(await probeOnce(p))) continue; // nothing listening — free
    // Find PID(s) via `ss`. Output lines look like:
    //   LISTEN 0 511 *:<port> *:* users:(("next-server",pid=12345,fd=6))
    let pid = null;
    try {
      const { stdout } = await exec("ss", ["-tlnp", `sport = :${p}`], { maxBuffer: 256 * 1024 });
      const m = stdout.match(/pid=(\d+)/);
      if (m) pid = Number(m[1]);
    } catch {
      // ss not available or failed — fall back to fuser
      try {
        const { stdout } = await exec("fuser", [`${p}/tcp`], { maxBuffer: 64 * 1024 });
        const m = stdout.trim().match(/\d+/);
        if (m) pid = Number(m[0]);
      } catch { /* can't determine PID — skip */ }
    }
    if (!pid) {
      log(`reap: port ${p} occupied but could not determine PID — skipping`);
      continue;
    }
    slog("warn", "reap", `reaping orphaned preview server on port ${p} (pid ${pid})`, { data: { port: p, pid } });
    try {
      process.kill(pid, "SIGTERM");
      // Give it 5 s then escalate
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    } catch { /* pid already gone */ }
    reaped.push({ port: p, pid });
  }
  if (reaped.length) log(`reaped ${reaped.length} orphaned preview server(s): ${reaped.map((r) => `port ${r.port} pid ${r.pid}`).join(", ")}`);
}

// ---------------------------------------------------------------- app content candidate (GitFS)
async function appsRepoExists() {
  try { await fs.access(path.join(APPS_REPO, ".git")); return true; } catch { return false; }
}
async function ensureAppsRepo() {
  if (await appsRepoExists()) return;
  await fs.mkdir(APPS_REPO, { recursive: true });
  await git(["init", "-q"], APPS_REPO);
  await git([...GIT_IDENTITY, "commit", "--allow-empty", "-q", "-m", "init content repo"], APPS_REPO).catch(() => {});
}
async function appBegin() {
  await ensureAppsRepo();
  if (appCandidate) return appCandidate;
  const cur = await git(["rev-parse", "--abbrev-ref", "HEAD"], APPS_REPO);
  const base = cur === APP_CANDIDATE_BRANCH ? "master" : cur;
  const exists = await gitTry(["rev-parse", "--verify", APP_CANDIDATE_BRANCH], ignoreGitError, APPS_REPO);
  await git(["checkout", ...(exists ? [APP_CANDIDATE_BRANCH] : ["-b", APP_CANDIDATE_BRANCH])], APPS_REPO);
  appCandidate = { branch: APP_CANDIDATE_BRANCH, base };
  log(`app candidate begun on ${APP_CANDIDATE_BRANCH} (base ${base})`);
  return appCandidate;
}
async function appPromote() {
  if (!appCandidate) throw new Error("no app candidate to promote");
  const { base } = appCandidate;
  await git(["checkout", base], APPS_REPO);
  await git([...GIT_IDENTITY, "merge", "--no-edit", APP_CANDIDATE_BRANCH], APPS_REPO);
  await gitTry(["branch", "-D", APP_CANDIDATE_BRANCH], ignoreGitError, APPS_REPO);
  appCandidate = null;
  log("app candidate promoted");
  return { promoted: true };
}
async function appDiscard() {
  if (!appCandidate) return { discarded: false };
  const { base } = appCandidate;
  await gitTry(["checkout", "-f", base], ignoreGitError, APPS_REPO);
  await gitTry(["branch", "-D", APP_CANDIDATE_BRANCH], ignoreGitError, APPS_REPO);
  appCandidate = null;
  log("app candidate discarded");
  return { discarded: true };
}

// Detects an auth-type git failure so pushWithRecovery doesn't waste time
// unshallowing/rebasing when the real problem is credentials — mirrors
// isAuthFailure in src/lib/gitops/git-ops.ts (the Settings → Git Remotes push
// path). Duplicated here rather than imported: the Supervisor is a
// standalone, dependency-light script (Node built-ins only) and does not
// import from src/lib.
function isGitAuthFailure(message) {
  return (
    /authentication/i.test(message) ||
    /permission denied/i.test(message) ||
    /fatal: .*(?:token|credential)/i.test(message) ||
    /401/.test(message) ||
    /403/.test(message) ||
    /could not read (username|password)/i.test(message) ||
    /terminal prompts disabled/i.test(message)
  );
}

// Push `branch` to `remote`, recovering from a non-fast-forward rejection
// caused by BrowserOS's own checkout being shallow — Dokploy re-clones
// `code/` with `--depth 1` on every redeploy (docs/dev/deployment.md), which
// leaves git unable to prove the local branch descends from the remote's even
// when nothing really conflicts. Mirrors the recovery the per-remote "Push"
// button performs (src/app/api/git-remotes/route.ts): unshallow, fetch, then
// retry once a genuine (non-diverged) fast-forward is confirmed possible.
// Deliberately does NOT rebase or force-push on a real divergence — this path
// also runs unattended (auto-push-on-promote), so it throws a clear,
// actionable error instead of guessing; the per-remote "Push" button is where
// a human resolves that (rebase-then-retry, or an explicit force-push).
async function pushWithRecovery(repoPath, remote, branch, extraArgs = []) {
  try {
    await git(["push", remote, branch, ...extraArgs], repoPath);
    return;
  } catch (e) {
    const msg = e?.message || String(e);
    if (isGitAuthFailure(msg)) throw e;

    const shallow = (await gitTry(["rev-parse", "--is-shallow-repository"], ignoreGitError, repoPath)) === "true";
    if (shallow) await gitTry(["fetch", "--unshallow", remote], ignoreGitError, repoPath);
    await gitTry(["fetch", remote, branch], ignoreGitError, repoPath);

    const mergeBase = await gitTry(["merge-base", "HEAD", `${remote}/${branch}`], ignoreGitError, repoPath);
    if (!mergeBase) {
      throw new Error(`push to ${remote}/${branch} rejected and no shared history was found even after unshallowing — refusing to guess; resolve manually via Settings → Versions → Git Remotes. Original error: ${msg}`);
    }
    const canFastForward = (await gitTry(["merge-base", "--is-ancestor", `${remote}/${branch}`, "HEAD"], ignoreGitError, repoPath)) !== null;
    if (!canFastForward) {
      throw new Error(`push to ${remote}/${branch} rejected: local and the remote have genuinely diverged (not just a shallow-history artifact) — resolve via Settings → Versions → Git Remotes, which can rebase or force-push. Original error: ${msg}`);
    }
    await git(["push", remote, branch, ...extraArgs], repoPath);
  }
}

// Push base's `branch` to `origin` via base's own /api/git-remotes push
// action, rather than a bare `git push` here. That route resolves OAuth/token
// credentials through BOS's git-credential-helper
// (src/lib/gitops/git-credential-helper.ts) — credentials the Supervisor (a
// separate, unbundled Node process with no access to src/lib/... or the
// SecretsStore, the same limitation a marketplace service's worker thread
// has) has no way to supply itself. A bare `git push origin ...` run from
// here carries no credentials at all and fails immediately with "could not
// read Username for '<host>'" the moment origin needs auth — i.e. always,
// for any HTTPS remote without a cached system-level credential. This
// happened for real via the "Push to remote" button in Settings → Versions.
async function pushOriginViaBaseApi(branch) {
  if (!base || base.state !== "ready") throw new Error("Base is not ready — cannot push to origin yet");
  const res = await fetch(`http://127.0.0.1:${base.port}/api/git-remotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "push", name: "origin", branch }),
  });
  const respBody = await res.json().catch(() => ({}));
  const errMsg = typeof respBody?.error === "string" ? respBody.error : respBody?.error?.message;
  if (!res.ok || errMsg) throw new Error(errMsg || `push to origin/${branch} failed with HTTP ${res.status}`);
  if (respBody.rebaseConflict) {
    throw new Error(respBody.message || `push to origin/${branch}: local and remote have diverged and automatic rebase conflicted — resolve via Settings → Versions → Git Remotes`);
  }
  if (respBody.unrelatedHistory) {
    throw new Error(respBody.message || `push to origin/${branch}: no shared history with the remote`);
  }
}

async function pushNow() {
  await pushOriginViaBaseApi(baseBranch);
  return { pushed: baseBranch };
}

// Auto-push: for each non-origin remote with autoPush enabled in the git-remotes
// config, push the base branch. Errors are logged but do not stop other pushes.
async function runAutoPush(repoPath, branch) {
  const configPath = path.join(CANONICAL_DATA, "config", "git-remotes.json");
  let configs;
  try {
    configs = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return [];
  }
  const remotes = (Array.isArray(configs) ? configs : []).filter(
    (r) => r.autoPush && r.name !== "origin"
  );
  if (!remotes.length) return [];
  const results = [];
  for (const remote of remotes) {
    try {
      await pushWithRecovery(repoPath, remote.name, branch, ["--follow-tags"]);
      results.push({ remoteName: remote.name, status: "success" });
      log(`auto-push to ${remote.name}: success`);
    } catch (e) {
      const msg = e.message || String(e);
      results.push({ remoteName: remote.name, status: "failed", error: msg });
      slog("warn", "promote", `auto-push to ${remote.name} failed: ${msg}`);
    }
  }
  return results;
}

// Push the just-promoted base branch to origin (gated by PUSH_MODE, matching
// prior behavior) and to every autoPush-enabled remote. Never throws — a push
// failure must not undo an already-successful promote — but unlike the old
// `gitTry`-based call this never swallows a failure silently: every outcome is
// both logged and returned so the caller (and ultimately the UI) can report
// "promoted, but push to X failed: <reason>" instead of a false all-clear.
async function pushPromotedBase(repoPath, branch) {
  const results = [];
  if (PUSH_MODE === "auto-on-promote") {
    try {
      await pushOriginViaBaseApi(branch);
      results.push({ remoteName: REMOTE, status: "success" });
      log(`auto-push to ${REMOTE}: success`);
    } catch (e) {
      const msg = e.message || String(e);
      results.push({ remoteName: REMOTE, status: "failed", error: msg });
      slog("error", "promote", `auto-push to ${REMOTE} failed: ${msg}`, { branch, versionLabel: "base" });
    }
  }
  results.push(...(await runAutoPush(repoPath, branch)));
  return results;
}

// Resume a STOPPED preview: start its server from the existing build output (no
// rebuild). Falls back to a full buildAndStart if the server doesn't come up (e.g.
// the .next output was deleted). Throws on failure.
async function resumePreview(branch) {
  const p = previews.get(requireFeatureBranch(branch));
  if (!p) throw new Error(`no preview to resume for ${branch}`);
  if (p.state === "ready" && p.proc) return p;
  startProc(p);
  p.state = "building";
  if (await waitHealthy(p.port, p)) {
    p.state = "ready";
    p.buildError = "";
    log(`resumed preview ${p.branch}`);
    return p;
  }
  // No existing build output — full rebuild.
  await stopProc(p);
  await buildAndStart(p);
  return p;
}

// ---------------------------------------------------------------- HTTP: proxy + control
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Resolve which running version serves this request. The pin cookie holds a branch
// name; it is only honored while that preview is "ready" (a still-building or
// stopped preview falls back to base, never a 502).
function pinnedVersion(req) {
  const pin = parseCookies(req)[PIN_COOKIE];
  if (!pin || pin === "base") return base;
  const p = previews.get(pin);
  if (p && p.state === "ready") return p;
  return base;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// Like readBody but caps the payload (log ingestion is the only large body we accept).
function readBodyCapped(req, maxBytes) {
  return new Promise((resolve) => {
    let b = "";
    let over = false;
    req.on("data", (c) => { if (over) return; b += c; if (b.length > maxBytes) { over = true; b = ""; } });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, obj, status = 200, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body);
}

function proxyTo(port, req, res, overridePath) {
  const up = http.request(
    { hostname: "127.0.0.1", port, path: overridePath ?? req.url, method: req.method, headers: req.headers },
    (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); },
  );
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/html" });
    res.end(
      `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;background:#0f1117;color:#e8eaf0;padding:40px;line-height:1.6">` +
        `<h2>This BrowserOS version isn't responding</h2>` +
        `<p>The Supervisor could not reach the upstream on port ${port}: <code>${e.message}</code>.</p>` +
        `<p>In <b>reuse</b> mode base proxies to an existing server — make sure <code>npm run dev</code> is running on that port. ` +
        `Or use <b>full</b> mode (omit <code>BOS_ACTIVE_REUSE_PORT</code>) so the Supervisor builds and serves it.</p>` +
        `<p>Control surface: <a href="/__supervisor" style="color:#a9c4ff">/__supervisor</a></p></body>`,
    );
  });
  req.pipe(up);
}

// Shared upgrade-forwarding: relay a WebSocket handshake + the two-way pipe to
// an upstream on 127.0.0.1:<port>. Used both for the pinned version's own
// socket (HMR) and for a service's own socket (proxyServiceUpgrade below).
function forwardUpgrade(port, req, clientSocket, head) {
  const up = http.request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || "Switching Protocols"}`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      for (const vv of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${vv}`);
    }
    clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead?.length) clientSocket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
    const close = () => { upSocket.destroy(); clientSocket.destroy(); };
    upSocket.on("error", close);
    clientSocket.on("error", close);
    upSocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upSocket.destroy());
  });
  up.on("error", (e) => {
    log(`ws upgrade to 127.0.0.1:${port}${req.url} failed: ${e.code || e.message}`);
    clientSocket.destroy();
  });
  up.end();
}

// Proxy a service's own traffic — WebSocket upgrade or plain HTTP — through
// the Supervisor's already-exposed, already-TLS-terminated PUBLIC_PORT.
// user-specs/002-service-daemons services bind their own internal port,
// which isn't reachable directly once BOS is deployed behind a reverse proxy
// (only PUBLIC_PORT is exposed/TLS-terminated there). Resolves the actual
// bound port from the pinned version's own dataDir()/system/config/<id>/runtime.json
// (written by ServiceManager.ts after the service's `bound` IPC message) —
// same per-version routing as the HMR case, so a preview's own services are
// reached, not always base's. See docs/dev/apps/services.md §11 for the full
// picture (both the WS and plain-HTTP cases, and the client-side pattern).
//
// The "system" segment is load-bearing: a service's live config is BOS-owned
// state under <dataDir>/system/config/<id>/, NOT <dataDir>/config/<id>/ (which
// holds unrelated top-level JSON: plugins.json, marketplaces.json, …). Reading
// the wrong one throws ENOENT, which the WS path surfaces only as a socket
// that never connects — see src/lib/marketplace/migrate-installed-state.ts
// for the layout.
async function resolveServicePort(req, serviceId, kind) {
  const v = pinnedVersion(req);
  if (!v) {
    log(`service ${kind} ${serviceId}: no version resolved for this request`);
    return null;
  }
  const runtimePath = path.join(v.dataDir, "system", "config", serviceId, "runtime.json");
  let port;
  try {
    const raw = await fs.readFile(runtimePath, "utf8");
    port = JSON.parse(raw).port;
  } catch (e) {
    log(`service ${kind} ${serviceId}: cannot read ${runtimePath} (${e.code || e.message}); is the service running?`);
    return null;
  }
  if (typeof port !== "number") {
    log(`service ${kind} ${serviceId}: ${runtimePath} has no numeric port (got ${JSON.stringify(port)})`);
    return null;
  }
  return port;
}

// WS case: only reachable mid-upgrade, where there is no response object to
// carry an error code — a silent destroy() here is indistinguishable from a
// hung network, so resolveServicePort's log is the only diagnostic.
async function proxyServiceUpgrade(serviceId, req, clientSocket, head) {
  const port = await resolveServicePort(req, serviceId, "ws");
  if (port == null) return clientSocket.destroy();
  forwardUpgrade(port, req, clientSocket, head);
}

// Plain-HTTP case: the non-upgrade counterpart, and what makes a service's
// own protocol reachable through the Supervisor even when that protocol isn't
// a WebSocket and isn't expressible as a Next.js route handler at all (e.g.
// WebDAV's PROPFIND/MKCOL/COPY/MOVE — Next.js's App Router only dispatches a
// fixed, standard set of HTTP methods). `subPath` is the request path with the
// `/__supervisor/services/<id>` prefix already stripped (plus the original
// query string), so the service sees exactly the path it would see if reached
// directly — no BOS-specific rewriting on its side.
async function proxyServiceHttp(serviceId, subPath, req, res) {
  const port = await resolveServicePort(req, serviceId, "http");
  if (port == null) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Service "${serviceId}" is not running or not installed.`);
    return;
  }
  proxyTo(port, req, res, subPath);
}

// "Occupied" means SOMETHING is listening on this port — not "something
// answered our HTTP GET." A raw TCP/WebSocket-only listener (e.g. a service's
// own daemon that never speaks plain HTTP, like Terminal's WebSocketServer)
// accepts the TCP connection but never sends a valid HTTP response, so the
// GET request just times out — which used to be misread as "nothing here,
// free" and let allocPreviewPort() hand that same port to a new preview
// build, which then failed with a real EADDRINUSE. Track the TCP-level
// connect event separately from the HTTP-level response: a successful TCP
// connect, even with no/garbled HTTP reply afterward, is occupied; only an
// outright connection refusal (nothing listening at all) is free.
function probeOnce(port) {
  return new Promise((resolve) => {
    let connected = false;
    const r = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => { res.resume(); resolve(true); });
    r.on("socket", (socket) => { socket.once("connect", () => { connected = true; }); });
    r.on("error", () => resolve(connected));
    r.on("timeout", () => { r.destroy(); resolve(connected); });
  });
}

async function handleControl(req, res, sub) {
  const sessionId = typeof req.headers["x-bos-session"] === "string" ? req.headers["x-bos-session"] : undefined;

  // --- central log store: ingestion (frontend + backend ship here) + reads (viewer) ---
  if (sub === "logs" && req.method === "POST") {
    const payload = await readBodyCapped(req, 2 * 1024 * 1024);
    const records = payload && Array.isArray(payload.records) ? payload.records : (Array.isArray(payload) ? payload : []);
    await logStore.writeBatch(records, { stream: "frontend", ...(sessionId ? { sessionId } : {}) });
    return sendJson(res, { ok: true, n: Array.isArray(records) ? records.length : 0 });
  }
  if (sub === "logs" && req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    if (q.get("sessions") === "1") return sendJson(res, { ok: true, sessions: await logStore.listSessions() });
    const records = await logStore.query({
      session: q.get("session") || undefined,
      stream: q.get("stream") || undefined,
      level: q.get("level") || undefined,
      since: q.get("since") ? Number(q.get("since")) : undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    });
    return sendJson(res, { ok: true, records });
  }
  // --- real health, for the bastion's System Monitor -------------------------
  // "Container is running" says nothing about whether BOS is serving: the
  // Supervisor is PID 1, so it stays up when the base server dies. This reports
  // the truth — a live PROBE of base plus the supervision counters — so the
  // bastion can distinguish "up" from "actually working".
  if (req.method === "GET" && sub === "health") {
    const proc = base?.proc ?? null;
    const procAlive = !!proc && proc.exitCode === null && !proc.signalCode;
    const serving = base ? await probeOnce(base.port) : false;
    const mem = process.memoryUsage();
    return sendJson(res, {
      ok: serving,
      serving,
      base: base
        ? {
            state: base.state,
            port: base.port,
            branch: base.branch ?? null,
            commit: base.commit ?? null,
            dev: !!base.dev,
            reused: !!base.reused,
            owned: !base.reused,
            pid: proc?.pid ?? null,
            procAlive,
            buildError: base.buildError || null,
          }
        : null,
      supervision: { ...baseSupervision },
      previews: [...previews.values()].map((p) => ({ branch: p.branch, port: p.port, state: p.state, procAlive: !!p.proc && p.proc.exitCode === null })),
      supervisor: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
      },
      baseBranch,
    });
  }
  if (req.method === "GET" && (sub === "" || sub === "state" || sub === "branches" || sub === "preview-changes" || sub === "next-changes")) {
    if (sub === "") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(controlPage()); return; }
    if (sub === "branches") return sendJson(res, { ok: true, branches: await listBranches(), base: baseBranch });
    if (sub === "preview-changes" || sub === "next-changes") {
      const branch = new URL(req.url, "http://localhost").searchParams.get("branch") || undefined;
      return sendJson(res, await previewChanges(branch));
    }
    // state — include which version THIS session is being served (the pin cookie),
    // so the toolbar can tell "you're viewing the preview" from "a preview exists
    // but you're still on base".
    const st = await publicState();
    const sv = pinnedVersion(req);
    return sendJson(res, { ...st, serving: sv ? { role: sv.role, branch: await liveBranch(sv) } : null });
  }
  const body = await readBody(req);
  slog("info", `control:${sub}`, `${sub} requested`, { ...(sessionId ? { sessionId } : {}), ...(body && Object.keys(body).length ? { data: body } : {}) });
  const clearPin = { "Set-Cookie": `${PIN_COOKIE}=; Path=/; Max-Age=0` };
  try {
    if (sub === "pin" && req.method === "POST") {
      const v = String(body.version || "base");
      const branch = String(body.branch || "");
      if (v === "base") return sendJson(res, { ok: true, pinned: "base" }, 200, clearPin);
      if (branch) {
        requireFeatureBranch(branch);
        const p = previews.get(branch);
        if (p && p.state === "ready") {
          return sendJson(res, { ok: true, pinned: branch }, 200, { "Set-Cookie": `${PIN_COOKIE}=${encodeURIComponent(branch)}; Path=/; HttpOnly` });
        }
        // If the preview is stopped, resume its server (no rebuild) then pin.
        if (p && p.state === "stopped") {
          await resumePreview(branch);
          if (p.state === "ready") {
            return sendJson(res, { ok: true, pinned: branch }, 200, { "Set-Cookie": `${PIN_COOKIE}=${encodeURIComponent(branch)}; Path=/; HttpOnly` });
          }
          return sendJson(res, { ok: false, error: `preview resume failed (state: ${p.state})` }, 400);
        }
        return sendJson(res, { ok: false, error: `preview for "${branch}" is not ready (state: ${p?.state || "absent"})` }, 400);
      }
      return sendJson(res, { ok: false, error: `branch required to pin` }, 400);
    }
    if (sub === "begin" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      const v = await beginPreview(branch);
      return sendJson(res, { ok: true, branch: v.branch, worktree: v.worktree });
    }
    if (sub === "build" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      const p = previews.get(branch) || (await provisionPreview(branch));
      const state = await buildPreview(branch, { sessionId });
      return sendJson(res, { ok: state === "ready", state, ...(p.buildError ? { error: p.buildError } : {}), ...(p.buildLog ? { buildLog: p.buildLog } : {}) });
    }
    if (sub === "activate" && req.method === "POST") {
      const branch = String(body.branch || "");
      const result = await activate(branch, { sessionId });
      const cookie = !branch || branch === baseBranch
        ? clearPin
        : {};
      return sendJson(res, { ok: true, ...result }, 200, cookie);
    }
    if (sub === "promote" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      return sendJson(res, { ok: true, ...(await promote(branch)) }, 200, clearPin);
    }
    // stop = stop the preview server but KEEP worktree + branch (can resume via /pin).
    // Order matters: clear the pin (→ switch to base) BEFORE killing the preview
    // process, so the user is never routed to a dead port. The response (with
    // clearPin) is sent immediately; stopPreview runs in the background.
    if (sub === "stop" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      sendJson(res, { ok: true }, 200, clearPin);
      void stopPreview(branch).catch((e) => slog("error", "control:stop", `background stop failed: ${String(e?.message || e)}`, { ...(sessionId ? { sessionId } : {}) }));
      return;
    }
    // discard = destroy everything including the feature branch.
    if (sub === "discard" && req.method === "POST") {
      const branch = String(body.branch || "");
      if (!branch) return sendJson(res, { ok: false, error: "branch required" }, 400);
      await discardPreview(branch);
      return sendJson(res, { ok: true }, 200, clearPin);
    }
    if (sub === "app-begin" && req.method === "POST") return sendJson(res, { ok: true, ...(await appBegin()) });
    if (sub === "app-promote" && req.method === "POST") return sendJson(res, { ok: true, ...(await appPromote()) });
    if (sub === "app-discard" && req.method === "POST") return sendJson(res, { ok: true, ...(await appDiscard()) });
    if (sub === "push" && req.method === "POST") return sendJson(res, { ok: true, ...(await pushNow()) });
  } catch (e) {
    const msg = String(e.message || e);
    slog("error", `control:${sub}`, `${sub} failed: ${msg}`, { ...(sessionId ? { sessionId } : {}), err: { message: msg } });
    return sendJson(res, { ok: false, error: msg }, 500);
  }
  return sendJson(res, { ok: false, error: "unknown control endpoint" }, 404);
}

function controlPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>BrowserOS Supervisor</title>
<style>body{font:14px system-ui;background:#0f1117;color:#e8eaf0;margin:0;padding:24px}h1{font-size:16px}
button{font:13px system-ui;margin:2px;padding:6px 10px;border:1px solid #2a2d36;background:#1b1e27;color:#e8eaf0;border-radius:6px;cursor:pointer}
button:hover{background:#262a35}pre{background:#0b0d12;border:1px solid #2a2d36;border-radius:8px;padding:12px;overflow:auto}
.row{margin:8px 0}</style></head><body>
<h1>BrowserOS Supervisor</h1>
<p>Version-independent control surface. Always reachable even if a BOS version's UI is broken.</p>
<div class="row">
  <button onclick="branchAct('pin',{version:'preview'})">Preview branch</button>
  <button onclick="act('pin',{version:'base'})">Back to base</button>
</div>
<div class="row">
  <button onclick="branchAct('activate')">Build/start branch</button>
  <button onclick="branchAct('build')">Retry build</button>
  <button onclick="branchAct('promote')">Promote</button>
  <button onclick="branchAct('stop')">Stop (keep branch)</button>
  <button onclick="branchAct('discard')">Discard (delete branch)</button>
  <button onclick="act('push')">Push to remote</button>
  <button onclick="refresh()">Refresh</button>
</div>
<pre id="state">loading…</pre>
<script>
async function refresh(){const r=await fetch('/__supervisor/state');document.getElementById('state').textContent=JSON.stringify(await r.json(),null,2);}
async function act(p,b){const r=await fetch('/__supervisor/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});const j=await r.json();if(j.pinned!==undefined){location.href='/';return;}alert(JSON.stringify(j));refresh();}
function branchAct(p,b){const branch=prompt('Feature branch (bos/<kebab-name>)');if(!branch)return;act(p,Object.assign({},b||{},{branch}));}
refresh();
</script></body></html>`;
}

// ---------------------------------------------------------------- main
async function main() {
  if (!baseBranch) baseBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  await reconcileWorktrees();
  await reapOrphanedPreviewServers();
  // Post-start safety gate: assert (and restore) the live checkout before accepting traffic.
  await assertRepoIntegrity("startup");

  // Logging retention (best-effort from the `logging` config namespace) + periodic prune.
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(CANONICAL_DATA, "config", "logging.json"), "utf8"));
    if (Number(cfg.retentionDays) > 0) logStore.retentionDays = Number(cfg.retentionDays);
    if (Number(cfg.maxSizeMb) > 0) logStore.maxBytes = Number(cfg.maxSizeMb) * 1024 * 1024;
  } catch { /* defaults */ }
  void logStore.prune();
  setInterval(() => void logStore.prune(), 3_600_000);

  if (BASE_DEV) {
    await buildAndStartBaseDev();
  } else if (REUSE_BASE_PORT) {
    base = { role: "base", port: REUSE_BASE_PORT, state: "ready", reused: true, branch: baseBranch, commit: await gitTry(["rev-parse", "HEAD"], ignoreGitError) };
    log(`reusing existing server on :${REUSE_BASE_PORT} as base (dev mode)`);
    if (!(await probeOnce(REUSE_BASE_PORT))) {
      log(`WARNING: nothing is responding on :${REUSE_BASE_PORT}. Reuse mode proxies base there — start \`npm run dev\` on :${REUSE_BASE_PORT} first, or set BOS_BASE_DEV=1 so the Supervisor owns + serves base itself.`);
    }
  } else {
    await buildAndStartBase(await git(["rev-parse", "HEAD"]));
  }

  // Restore previews from git branches. Runtime state is reconstructed, not persisted.
  await restorePreviews();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    // A service's own plain-HTTP traffic, at /__supervisor/services/<id>(/...)
    // — see proxyServiceHttp. Checked before the generic /__supervisor/*
    // control-route branch below, since this shares the same prefix.
    const svcMatch = url.pathname.match(/^\/__supervisor\/services\/([a-zA-Z0-9._-]+)(\/.*)?$/);
    if (svcMatch) {
      const subPath = (svcMatch[2] || "/") + url.search;
      void proxyServiceHttp(svcMatch[1], subPath, req, res);
      return;
    }
    if (url.pathname === "/__supervisor" || url.pathname.startsWith("/__supervisor/")) {
      const sub = url.pathname === "/__supervisor" ? "" : url.pathname.slice("/__supervisor/".length);
      void handleControl(req, res, sub);
      return;
    }
    const port = pinnedVersion(req)?.port;
    if (!port) { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("No base version"); return; }
    proxyTo(port, req, res);
  });

  // Proxy WebSocket upgrades: a service's own socket (e.g. Terminal's shell
  // socket, at /__supervisor/services/<id>/ws — see proxyServiceUpgrade)
  // takes priority; everything else (e.g. next dev's HMR socket) forwards to
  // the pinned version as before.
  server.on("upgrade", (req, clientSocket, head) => {
    const url = new URL(req.url, "http://localhost");
    const svcMatch = url.pathname.match(/^\/__supervisor\/services\/([a-zA-Z0-9._-]+)\/ws$/);
    if (svcMatch) {
      void proxyServiceUpgrade(svcMatch[1], req, clientSocket, head);
      return;
    }
    const port = pinnedVersion(req)?.port;
    if (!port) return clientSocket.destroy();
    forwardUpgrade(port, req, clientSocket, head);
  });

  server.listen(PUBLIC_PORT, () => log(`listening on :${PUBLIC_PORT} (base branch: ${baseBranch}, base port: ${BASE_PORT}, preview pool: ${BASE_PORT + 1}-${BASE_PORT + POOL_SIZE}); control at /__supervisor`));
}

// Kill the Supervisor's OWNED servers (base + all previews) when it exits. Those
// children are spawned `detached` (own process group) so stopProc can kill the
// whole group — but detached also means they would OUTLIVE the Supervisor on
// Ctrl+C. Reap them here. A reused (external) base has no owned proc and is left
// alone (it's the user's own process).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal} — stopping owned servers (base + previews)`);
  try {
    await Promise.all([stopProc(base), ...[...previews.values()].map((p) => stopProc(p))]);
  } catch { /* best effort */ }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => void shutdown(sig));

main().catch((e) => { console.error("[supervisor] fatal:", e); process.exit(1); });
