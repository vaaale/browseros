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
const WORKTREES = process.env.BOS_WORKTREES || path.join(path.dirname(REPO), "bos-worktrees");
const CANONICAL_DATA = process.env.BOS_CANONICAL_DATA || path.join(REPO, "data");
const CLONES = process.env.BOS_DATA_CLONES || path.join(path.dirname(REPO), "bos-data-clones");
const PUSH_MODE = process.env.BOS_PUSH_MODE || "manual";        // manual | auto-on-promote
const REMOTE = process.env.BOS_REMOTE || "origin";
const HEALTH_TIMEOUT_MS = Number(process.env.BOS_HEALTH_TIMEOUT_MS || 120_000);
// Reuse an already-running server as BASE (dev convenience / testing).
const REUSE_BASE_PORT = process.env.BOS_ACTIVE_REUSE_PORT ? Number(process.env.BOS_ACTIVE_REUSE_PORT) : null;
// Supervisor-OWNED dev base: the Supervisor spawns `next dev` for base itself
// (single-process model — just start the Supervisor). Because it owns the process
// it can npm-install + restart base on promote, with HMR during development.
const BASE_DEV = /^(1|true|yes)$/i.test(process.env.BOS_BASE_DEV || "");
const PIN_COOKIE = "bos_pin";

// Apps content repo (GitFS) — versioned user apps, a standalone repo independent
// of BOS source. App candidates are git BRANCHES here (not worktrees + a second
// server): the base BOS serves the apps repo's working tree, so checking out the
// candidate branch makes the in-progress app visible ("branch-live" preview),
// promote merges it to the base branch, discard drops it. Orthogonal to the
// BOS-code preview flow above and needs no extra port/proxy.
const APPS_REPO = process.env.BOS_APPS_DIR || path.join(REPO, "apps");
// Container of external spec stores (018). Mounted read-only into each preview
// worktree at `specs/` so the developer harness can READ the spec it implements
// (and the constitution) even though specs no longer live in the source tree.
const SPECS_ROOT = process.env.BOS_SPECS_ROOT || path.join(REPO, "specs");
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
/** @typedef {{role:string,branch?:string,worktree?:string,dataDir?:string,port:number,state:string,proc?:import('node:child_process').ChildProcess|null,commit?:string,reused?:boolean}} Version */
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
  const b = await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], v.worktree || REPO);
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
    v ? { role: v.role, branch: await liveBranch(v), port: v.port, state: v.state, commit: v.commit, reused: !!v.reused, ...(v.buildError ? { buildError: v.buildError } : {}), ...(v.buildLog ? { buildLog: v.buildLog } : {}) } : null;
  const b = await pick(base);
  const ps = await Promise.all([...previews.values()].map(pick));
  return { base: b, previews: ps, appCandidate, pushMode: PUSH_MODE, baseBranch };
}

// On startup, scan git for bos/* feature branches and re-provision their
// worktrees. Runtime state is intentionally not persisted: restored previews are
// treated as not-built and can be rebuilt or resumed explicitly.
async function restorePreviews() {
  const raw = (await gitTry(["branch", "--list", `${FEATURE_BRANCH_PREFIX}*`, "--format=%(refname:short)"])) || "";
  const branches = raw.split("\n").map((s) => s.trim()).filter((s) => s && s !== "HEAD");
  if (!branches.length) return;
  for (const branch of branches) {
    if (!isFeatureBranch(branch)) continue;
    // Skip if already in the map (e.g. provisioned during this run).
    if (previews.has(branch)) continue;
    try {
      const wt = await addWorktreeForBranch(branch);
      const clone = clonePath(branch);
      await provisionClone(clone);
      const port = await allocPreviewPort();
      const p = { role: "preview", branch, worktree: wt, dataDir: clone, port, state: "not-built", proc: null, commit: await gitTry(["rev-parse", "HEAD"], wt) };
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
async function gitTry(args, cwd = REPO) {
  try { return await git(args, cwd); } catch { return null; }
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
    const branch = await gitTry(["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = await gitTry(["status", "--porcelain"]);
    const violated = branch !== baseBranch || !!dirty;
    if (!violated) return false; // fast path — everything is fine

    const msg =
      `SAFETY GATE VIOLATED${context ? ` (${context})` : ""}: ` +
      `REPO branch="${branch}" (expected "${baseBranch}"), dirty="${dirty || ""}". ` +
      `Something edited or branched the live checkout instead of the isolated preview worktree. ` +
      `Attempting safe restore.`;
    slog("error", "safety-gate", msg, { branch, baseBranch, dirty: dirty || "" });

    // Attempt restore: switch back to baseBranch and discard any uncommitted changes.
    if (branch !== baseBranch) {
      await gitTry(["checkout", baseBranch]).catch(() => {});
    }
    if (dirty) {
      await gitTry(["reset", "--hard", "HEAD"]).catch(() => {});
      await gitTry(["clean", "-fd"]).catch(() => {});
    }

    const afterBranch = await gitTry(["rev-parse", "--abbrev-ref", "HEAD"]);
    const afterDirty = await gitTry(["status", "--porcelain"]);
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
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
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

// Mount the external spec stores READ-ONLY into a worktree at `specs/` (018), so
// the developer harness reads the spec it implements at `specs/<store>/<id>/…`.
// A copy (reflink where supported): harness edits stay in the worktree copy and
// never flow back to the store, and because the BOS repo gitignores `specs/`, the
// mount is excluded from the candidate `git add -A`. Refreshed on every begin so
// an edited spec is current. No-op when there is no spec store yet.
async function mountSpecStores(wt) {
  const dst = path.join(wt, "specs");
  try {
    await fs.access(SPECS_ROOT);
  } catch {
    return; // no stores to mount
  }
  await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
  const run = (args) => exec("cp", args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  try {
    await run(["-a", "--reflink=auto", `${SPECS_ROOT}/.`, dst]);
  } catch {
    await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
    await run(["-a", `${SPECS_ROOT}/.`, dst]).catch(() => {});
  }
}

// Create/replace the BASE worktree: detached at `commit` so it never conflicts with
// REPO's own checkout of baseBranch. Fixed location (base is a singleton).
async function addBaseWorktree(commit) {
  const wt = path.join(WORKTREES, "base");
  await gitTry(["worktree", "remove", "--force", wt]);
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(WORKTREES, { recursive: true });
  await git(["worktree", "add", "--detach", wt, commit]);
  await hydrateWorktree(wt);
  return wt;
}

// Create/replace a worktree for an EXISTING branch at WORKTREES/<branch>. Branch
// names may contain '/', kept as nested dirs (git ref rules forbid foo AND foo/bar
// at once, so no path collision); mkdir the parent.
async function addWorktreeForBranch(branch) {
  const wt = worktreePath(branch);
  await gitTry(["worktree", "remove", "--force", wt]);
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.dirname(wt), { recursive: true });
  // Clear any stale worktree registration (e.g. a worktree dir removed by hand, or a
  // leftover lock) so `worktree add` can't fail with "already registered"/"already
  // checked out" — the failure that would otherwise push the caller into editing the
  // live checkout in place (specs/017-central-logging diagnosis).
  await gitTry(["worktree", "prune"]);
  await git(["worktree", "add", wt, branch]);
  await hydrateWorktree(wt);
  return wt;
}

function startProc(v) {
  v.proc = spawn("npx", ["next", "start", "-p", String(v.port)], {
    cwd: v.worktree,
    // BOS_CANONICAL_DATA lets a version persist cross-version state (e.g. chat
    // conversation metadata) to canonical data even when it runs on a throwaway
    // preview clone, so it survives Stop/promote.
    env: { ...process.env, PORT: String(v.port), BOS_DATA_DIR: v.dataDir, BOS_CANONICAL_DATA: CANONICAL_DATA, BOS_VERSION_LABEL: v.role, BOS_BASE_BRANCH: baseBranch },
    stdio: "inherit",
    // detached: true puts the child in its own process group so stopProc can
    // kill the ENTIRE group (npx + its next-server child) via negative PID.
    // Without this, killing npx orphans the next process which keeps the port.
    detached: true,
  });
  v.proc.on("exit", (code) => {
    slog(code === 0 || code === null ? "info" : "warn", "process", `version "${v.role}" (${v.branch}) process exited (${code})`, { branch: v.branch, versionLabel: v.role, data: { code } });
    // An unexpected death of a running version must not keep routing traffic to a
    // dead port — mark it so pinnedVersion falls back to base.
    if (v.state === "ready") v.state = "stopped";
    else if (v.state === "building") {
      v.state = "failed";
      v.buildError = `preview process exited before becoming healthy (code ${code ?? "null"})`;
    }
  });
}

// Stop a version's server and RESOLVE ONLY AFTER it has actually exited, so the
// port is free to rebind (critical when reusing the base port on promote). SIGKILL
// escalation guards against a process that ignores SIGTERM.
function stopProc(v) {
  return new Promise((resolve) => {
    const p = v?.proc;
    if (!p || p.killed || p.exitCode !== null || p.signalCode) { if (v) v.proc = null; return resolve(); }
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

function startBaseDevProc(v) {
  // Run via `npm run dev` (not `npx next dev`) so the `predev` hook regenerates the
  // built-in app registry on every start/restart. Pass the port after `--`.
  v.proc = spawn("npm", ["run", "dev", "--", "-p", String(v.port)], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(v.port),
      BOS_DATA_DIR: CANONICAL_DATA,
      BOS_CANONICAL_DATA: CANONICAL_DATA,
      BOS_VERSION_LABEL: "base",
      BOS_BASE_BRANCH: baseBranch,
      BOS_SUPERVISOR_URL: `http://127.0.0.1:${PUBLIC_PORT}`,
    },
    stdio: "inherit",
    detached: true,
  });
  v.proc.on("exit", (code) => {
    slog(code === 0 || code === null ? "info" : "warn", "process", `base dev server exited (${code})`, { branch: v.branch, versionLabel: "base", data: { code } });
    if (v.state === "ready") v.state = "stopped";
  });
}

// Start base as a Supervisor-owned `next dev` process (single-process model).
async function buildAndStartBaseDev() {
  const commit = await gitTry(["rev-parse", "HEAD"]);
  base = { role: "base", branch: baseBranch, worktree: REPO, dataDir: CANONICAL_DATA, port: BASE_PORT, state: "building", proc: null, commit, dev: true };
  slog("info", "build", `starting owned base dev server (${baseBranch}) on :${BASE_PORT}`, { branch: baseBranch, versionLabel: "base" });
  startBaseDevProc(base);
  base.state = (await waitHealthy(BASE_PORT, base)) ? "ready" : "failed";
  if (base.state !== "ready") throw new Error(`base dev server failed to become healthy on :${BASE_PORT}`);
  log(`owned base dev server ready on :${BASE_PORT} (branch ${baseBranch})`);
  return base.state;
}

// Predict whether the candidate can be rebased onto base WITHOUT touching the
// worktree (so a conflict leaves the running preview intact). Returns null when the
// 3-way merge applies cleanly, else the conflict report (which files).
async function mergeTreeConflicts(cwd, ref) {
  const mb = await gitTry(["merge-base", ref, "HEAD"], cwd);
  if (!mb) return null; // no common base resolvable — let the rebase itself decide
  try {
    await exec("git", ["merge-tree", "--write-tree", `--merge-base=${mb}`, ref, "HEAD"], { cwd, maxBuffer: 8 * 1024 * 1024 });
    return null; // exit 0 = clean
  } catch (e) {
    const out = `${String(e.stdout || "")}\n${String(e.stderr || "")}`.trim();
    return out || "merge conflicts (manual resolution required)";
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
  const exists = await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (!exists) {
    const from = base?.commit || (await git(["rev-parse", "HEAD"]));
    await git(["branch", branch, from]);
  }
  const wt = await addWorktreeForBranch(branch);
  const clone = clonePath(branch);
  await provisionClone(clone);
  const port = await allocPreviewPort();
  const p = { role: "preview", branch, worktree: wt, dataDir: clone, port, state: "not-built", proc: null, commit: await gitTry(["rev-parse", "HEAD"], wt) };
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
    await gitTry(["branch", "-D", branch]);
    log(`discarded preview ${branch} (branch deleted)`);
    return;
  }
  await stopProc(p);
  await gitTry(["worktree", "remove", "--force", p.worktree]);
  await fs.rm(p.dataDir, { recursive: true, force: true }).catch(() => {});
  await gitTry(["branch", "-D", p.branch]);
  log(`discarded preview ${p.branch} (branch deleted)`);
}

async function beginPreview(branch) {
  const p = await provisionPreview(branch);
  // (Re)mount the spec stores read-only on every begin — fresh provision or reuse —
  // so the harness always sees the current spec content.
  await mountSpecStores(p.worktree).catch((e) => slog("warn", "begin", `spec mount failed for ${branch}: ${e?.message || e}`, { branch }));
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

  const dirty = await gitTry(["status", "--porcelain"], REPO);
  if (dirty) {
    throw new Error(`base checkout (${REPO}) has uncommitted changes — commit, stash, or discard them before promoting:\n${dirty}`);
  }

  // 1) Make the preview a clean descendant of base, in its own worktree. FF: already
  //    ahead → nothing to do. Non-FF: rebase onto base, then rebuild + re-gate.
  if ((await gitTry(["merge-base", "--is-ancestor", baseBranch, "HEAD"], cand.worktree)) === null) {
    const conflicts = await mergeTreeConflicts(cand.worktree, baseBranch);
    if (conflicts) throw new Error(`preview ${cand.branch} can't be auto-rebased onto ${baseBranch} — manual merge required:\n${conflicts}`);
    await stopProc(cand);
    try {
      await git(["rebase", baseBranch], cand.worktree);
    } catch (e) {
      await gitTry(["rebase", "--abort"], cand.worktree);
      throw new Error(`auto-rebase of ${cand.branch} onto ${baseBranch} failed: ${e.message || e}`);
    }
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
    if (PUSH_MODE === "auto-on-promote") await gitTry(["push", REMOTE, baseBranch, "--follow-tags"], REPO);
    base.commit = newCommit;
    // Regenerate the built-in app registry so a merged built-in app (its generated
    // manifest is gitignored, thus not in the merge) is actually registered on base.
    await regenApps();
    const changed = (prevBaseCommit ? await gitTry(["diff", "--name-only", `${prevBaseCommit}..${newCommit}`], REPO) : "") || "";
    const depsChanged = /(^|\n)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)/.test(changed);
    const configChanged = /(^|\n)(next\.config\.|tsconfig|\.env)/.test(changed);
    // Reap the promoted preview before touching base (frees resources / the branch).
    await stopProc(cand);
    await gitTry(["worktree", "remove", "--force", cand.worktree]);
    await fs.rm(cand.dataDir, { recursive: true, force: true }).catch(() => {});
    await gitTry(["branch", "-D", cand.branch]);
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
      return { tag, branch: cand.branch, dev: true };
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
  if (PUSH_MODE === "auto-on-promote") await gitTry(["push", REMOTE, baseBranch, "--follow-tags"], REPO);

  // 4) Adopt the swapped server as base. Detach its worktree off the feature branch
  //    (same commit → no file change, server keeps running) so the now-merged branch
  //    can be deleted and base isn't sitting "on" a feature branch. Clean up.
  base = swapped;
  await stopProc(cand); // the preview's pool-port server is now redundant — reap it so it doesn't leak
  await gitTry(["checkout", "--detach"], swapped.worktree);
  base.branch = baseBranch;
  if (oldBase?.worktree && oldBase.worktree !== swapped.worktree) await gitTry(["worktree", "remove", "--force", oldBase.worktree]);
  await fs.rm(cand.dataDir, { recursive: true, force: true }).catch(() => {});
  await gitTry(["branch", "-D", cand.branch]); // merged into base; the preview is gone
  previews.delete(cand.branch);
  log(`promoted ${cand.branch} → base (tag ${tag})`);
  return { tag, branch: cand.branch };
}

// Files changed on the preview vs the base branch. The agent's edits are COMMITTED
// in the preview worktree (buildAndStart), so the main checkout looks clean — this
// surfaces the real change so the assistant's gitStatus isn't fooled.
async function previewChanges(branch) {
  const p = branch ? previews.get(branch) : null;
  if (!p) return { ok: true, candidate: null };
  const raw = (await gitTry(["diff", "--name-status", `${baseBranch}...HEAD`], p.worktree)) || "";
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
  const raw = (await gitTry(["branch", "--format=%(refname:short)"])) || "";
  const branches = raw.split("\n").map((s) => s.trim()).filter((s) => s && s !== "HEAD");
  if (!branches.includes(baseBranch)) branches.unshift(baseBranch);
  return branches;
}

// On startup, remove the Supervisor's own leftover worktrees from a previous run
// (their processes died with the old supervisor). The BRANCHES survive, so an
// orphaned preview stays selectable from the dropdown — this just prevents
// `git worktree add` collisions and stale-port confusion.
async function reconcileWorktrees() {
  await gitTry(["worktree", "prune"]);
  const list = (await gitTry(["worktree", "list", "--porcelain"])) || "";
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length).trim();
    if (wt && wt !== REPO && wt.startsWith(WORKTREES)) {
      await gitTry(["worktree", "remove", "--force", wt]);
      await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
    }
  }
  await gitTry(["worktree", "prune"]);
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
  const exists = await gitTry(["rev-parse", "--verify", APP_CANDIDATE_BRANCH], APPS_REPO);
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
  await gitTry(["branch", "-D", APP_CANDIDATE_BRANCH], APPS_REPO);
  appCandidate = null;
  log("app candidate promoted");
  return { promoted: true };
}
async function appDiscard() {
  if (!appCandidate) return { discarded: false };
  const { base } = appCandidate;
  await gitTry(["checkout", "-f", base], APPS_REPO);
  await gitTry(["branch", "-D", APP_CANDIDATE_BRANCH], APPS_REPO);
  appCandidate = null;
  log("app candidate discarded");
  return { discarded: true };
}

async function pushNow() {
  await git(["push", REMOTE, baseBranch, "--follow-tags"], REPO);
  return { pushed: baseBranch };
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

function proxyTo(port, req, res) {
  const up = http.request(
    { hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers },
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

function probeOnce(port) {
  return new Promise((resolve) => {
    const r = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => { res.resume(); resolve(true); });
    r.on("error", () => resolve(false));
    r.on("timeout", () => { r.destroy(); resolve(false); });
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
    base = { role: "base", port: REUSE_BASE_PORT, state: "ready", reused: true, branch: baseBranch, commit: await gitTry(["rev-parse", "HEAD"]) };
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
    if (url.pathname === "/__supervisor" || url.pathname.startsWith("/__supervisor/")) {
      const sub = url.pathname === "/__supervisor" ? "" : url.pathname.slice("/__supervisor/".length);
      void handleControl(req, res, sub);
      return;
    }
    const port = pinnedVersion(req)?.port;
    if (!port) { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("No base version"); return; }
    proxyTo(port, req, res);
  });

  // Proxy WebSocket upgrades (e.g. next dev's HMR socket) to the pinned version.
  server.on("upgrade", (req, clientSocket, head) => {
    const port = pinnedVersion(req)?.port;
    if (!port) return clientSocket.destroy();
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
    up.on("error", () => clientSocket.destroy());
    up.end();
  });

  server.listen(PUBLIC_PORT, () => log(`listening on :${PUBLIC_PORT} (base branch: ${baseBranch}, base port: ${BASE_PORT}, preview pool: ${BASE_PORT + 1}-${BASE_PORT + POOL_SIZE}); control at /__supervisor`));
}

main().catch((e) => { console.error("[supervisor] fatal:", e); process.exit(1); });
