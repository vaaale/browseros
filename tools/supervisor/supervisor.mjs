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
const PIN_COOKIE = "bos_pin";

// Apps content repo (GitFS) — versioned user apps, a standalone repo independent
// of BOS source. App candidates are git BRANCHES here (not worktrees + a second
// server): the base BOS serves the apps repo's working tree, so checking out the
// candidate branch makes the in-progress app visible ("branch-live" preview),
// promote merges it to the base branch, discard drops it. Orthogonal to the
// BOS-code preview flow above and needs no extra port/proxy.
const APPS_REPO = process.env.BOS_APPS_DIR || path.join(REPO, "apps");
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
// commit so it never conflicts with REPO's own checkout of baseBranch) and at most
// one PREVIEW (a feature branch in a branch-named worktree).
/** @typedef {{role:string,branch?:string,worktree?:string,dataDir?:string,port:number,state:string,proc?:import('node:child_process').ChildProcess|null,commit?:string,reused?:boolean}} Version */
/** @type {Version|null} */ let base = null;
/** @type {Version|null} */ let preview = null;

function worktreePath(branch) { return path.join(WORKTREES, branch); }
function clonePath(branch) { return path.join(CLONES, branch); }
function newPreviewBranch() { return `bos/next-${Date.now().toString(36)}`; }
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
  if (preview?.port) used.add(preview.port);
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
  return (await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], v.worktree || REPO)) || v.branch;
}
async function publicState() {
  const pick = async (v) =>
    v ? { role: v.role, branch: await liveBranch(v), port: v.port, state: v.state, commit: v.commit, reused: !!v.reused, ...(v.buildError ? { buildError: v.buildError } : {}), ...(v.buildLog ? { buildLog: v.buildLog } : {}) } : null;
  const [b, p] = await Promise.all([pick(base), pick(preview)]);
  return { base: b, preview: p, appCandidate, pushMode: PUSH_MODE, baseBranch };
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
// This catches any remaining path that accidentally edits or branches the main
// checkout instead of the isolated preview worktree.
async function assertRepoIntegrity(context = "") {
  try {
    const branch = await gitTry(["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = await gitTry(["status", "--porcelain"]);
    const violated = branch !== baseBranch || !!dirty;
    if (!violated) return; // fast path — everything is fine

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
  } catch (e) {
    slog("error", "safety-gate", `assertRepoIntegrity check itself failed: ${e.message || e}`);
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
// Turbopack ("points out of the filesystem root"), so hardlink-clone the repo's
// node_modules into the worktree — cheap on the same filesystem (shared inodes),
// falling back to a full copy. Also carry env secrets (also gitignored).
async function hydrateWorktree(wt) {
  const nm = path.join(wt, "node_modules");
  try {
    await exec("cp", ["-al", path.join(REPO, "node_modules"), nm], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  } catch {
    await exec("cp", ["-a", path.join(REPO, "node_modules"), nm], { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 }).catch(() => {});
  }
  for (const f of [".env", ".env.local"]) {
    await fs.copyFile(path.join(REPO, f), path.join(wt, f)).catch(() => {});
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
    // BOS_CANONICAL_DATA lets a version persist cross-version state (e.g. the
    // conversation→branch map) to canonical data even when it runs on a throwaway
    // preview clone, so it survives Stop/promote.
    env: { ...process.env, PORT: String(v.port), BOS_DATA_DIR: v.dataDir, BOS_CANONICAL_DATA: CANONICAL_DATA, BOS_VERSION_LABEL: v.role },
    stdio: "inherit",
  });
  v.proc.on("exit", (code) => {
    slog(code === 0 || code === null ? "info" : "warn", "process", `version "${v.role}" (${v.branch}) process exited (${code})`, { branch: v.branch, versionLabel: v.role, data: { code } });
    // An unexpected death of a running version must not keep routing traffic to a
    // dead port — mark it so pinnedVersion falls back to base.
    if (v.state === "ready") v.state = "stopped";
  });
}

// Stop a version's server and RESOLVE ONLY AFTER it has actually exited, so the
// port is free to rebind (critical when reusing the base port on promote). SIGKILL
// escalation guards against a process that ignores SIGTERM.
function stopProc(v) {
  return new Promise((resolve) => {
    const p = v?.proc;
    if (!p || p.killed || p.exitCode !== null || p.signalCode) { if (v) v.proc = null; return resolve(); }
    p.once("exit", () => { v.proc = null; resolve(); });
    try { p.kill("SIGTERM"); } catch { v.proc = null; return resolve(); }
    setTimeout(() => { try { if (p.exitCode === null && !p.signalCode) p.kill("SIGKILL"); } catch { /* ignore */ } }, 5000);
  });
}

async function waitHealthy(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
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
function runBuild(cwd, branch, ctx = {}) {
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
  await git(["commit", "-m", `BOS candidate (${v.branch})`], v.worktree).catch(() => {});
  v.commit = await git(["rev-parse", "HEAD"], v.worktree).catch(() => v.commit);
  // Safety gate: the worktree commit must never have leaked into the main checkout.
  await assertRepoIntegrity(`build ${v.branch}`);
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
  v.state = (await waitHealthy(v.port)) ? "ready" : "failed";
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
  base.state = (await waitHealthy(BASE_PORT)) ? "ready" : "failed";
  slog(base.state === "ready" ? "info" : "error", "build", `base -> ${base.state}`, { ...lctx, buildLog: build.relPath });
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
// Provision (or resume) a PREVIEW for `branch`: branch-named worktree + data clone +
// a pooled port. An existing branch is checked out with its committed history
// (continuity after a Stop or restart); a missing one is created off base. Does NOT
// build — the developer agent edits the worktree, then /build runs.
async function provisionPreview(branch) {
  if (!branch || branch === baseBranch) return null;
  if (preview && preview.branch !== branch) await dropPreview(); // one preview at a time (kill-on-switch)
  const exists = await gitTry(["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (!exists) {
    const from = base?.commit || (await git(["rev-parse", "HEAD"]));
    await git(["branch", branch, from]);
  }
  const wt = await addWorktreeForBranch(branch);
  const clone = clonePath(branch);
  await provisionClone(clone);
  const port = await allocPreviewPort();
  preview = { role: "preview", branch, worktree: wt, dataDir: clone, port, state: "idle", proc: null, commit: await gitTry(["rev-parse", "HEAD"], wt) };
  log(`preview ${branch} provisioned on port ${port}`);
  return preview;
}

// Stop + clean the current preview (kill its server, remove its worktree + data
// clone). The BRANCH is intentionally left intact so the work can be resumed later.
async function dropPreview() {
  if (!preview) return;
  const p = preview;
  preview = null;
  await stopProc(p);
  await gitTry(["worktree", "remove", "--force", p.worktree]);
  await fs.rm(p.dataDir, { recursive: true, force: true }).catch(() => {});
  log(`dropped preview ${p.branch} (branch kept)`);
}

// /begin — provision (or resume) the preview worktree for the developer agent.
// Reuses the current preview when the branch matches (or none is given, e.g. an
// agent iterating mid-session) so its uncommitted edits aren't wiped.
async function beginPreview(branch) {
  if (preview && (!branch || preview.branch === branch)) return preview;
  return await provisionPreview(branch || newPreviewBranch());
}

async function buildPreview(ctx = {}) {
  if (!preview) throw new Error("no preview to build");
  return await buildAndStart(preview, ctx);
}

// Toolbar branch selection. Base → drop any preview, back to base. An already-ready
// preview of the same branch → just (re)pin (no rebuild). Otherwise provision +
// build in the background; the pin only routes once it reports ready.
async function activate(branch) {
  if (!branch || branch === baseBranch) { await dropPreview(); return { base: true }; }
  if (preview && preview.branch === branch && preview.state === "ready") return { branch, state: "ready" };
  await beginPreview(branch);
  void buildPreview().catch((e) => { if (preview) preview.state = "failed"; log(`activate build failed: ${e.message || e}`); });
  return { branch, state: "building" };
}

// Promote the preview to BASE. Safe ordering: do every fallible step (rebase, build,
// off-port health-gate) while base still serves; only AFTER the new code is healthy
// on the base port do we advance the base branch ref + tag (the point of no return).
// A failure before that leaves the base branch untouched and restores the old base.
async function promote() {
  const cand = preview;
  if (!cand) throw new Error("no preview to promote");
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

  // 2) Swap on the base port: stop old base (await exit), start the candidate's code
  //    on BASE_PORT against CANONICAL data, health-gate THERE.
  const oldBase = base;
  await stopProc(oldBase);
  const swapped = { role: "base", branch: cand.branch, worktree: cand.worktree, dataDir: CANONICAL_DATA, port: BASE_PORT, state: "building", proc: null, commit: newCommit };
  startProc(swapped);
  if (!(await waitHealthy(BASE_PORT))) {
    // Failure AFTER killing old base but BEFORE moving the base ref → restore old base.
    await stopProc(swapped);
    if (oldBase) { startProc(oldBase); await waitHealthy(oldBase.port); base = oldBase; }
    throw new Error(`promote failed: ${cand.branch} did not become healthy on the base port; restored the previous base. The base branch was NOT moved.`);
  }

  // 3) Point of no return: fast-forward the base branch to the candidate, tag, push.
  await git(["checkout", baseBranch], REPO);
  await git(["merge", "--ff-only", newCommit], REPO);
  const tag = `bos/v${tagStamp()}`;
  await git(["tag", "-a", tag, "-m", `promote ${cand.branch}`], REPO);
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
  await gitTry(["branch", "-D", cand.branch]); // merged into base; clears the conversation's anchor (resolved by existence check)
  preview = null;
  log(`promoted ${cand.branch} → base (tag ${tag})`);
  return { tag, branch: cand.branch };
}

// Files changed on the preview vs the base branch. The agent's edits are COMMITTED
// in the preview worktree (buildAndStart), so the main checkout looks clean — this
// surfaces the real change so the assistant's gitStatus isn't fooled.
async function previewChanges() {
  if (!preview) return { ok: true, candidate: null };
  const raw = (await gitTry(["diff", "--name-status", `${baseBranch}...HEAD`], preview.worktree)) || "";
  const files = raw
    ? raw.split("\n").filter(Boolean).map((l) => {
        const tab = l.indexOf("\t");
        return tab < 0 ? { status: l.trim(), path: "" } : { status: l.slice(0, tab).trim(), path: l.slice(tab + 1) };
      })
    : [];
  return { ok: true, candidate: { branch: await liveBranch(preview), base: baseBranch, state: preview.state, commit: preview.commit, files } };
}

// All git branches for the toolbar dropdown (including bos/* feature branches, so an
// orphaned preview from a previous run can be re-selected). Base is always present.
async function listBranches() {
  const raw = (await gitTry(["branch", "--format=%(refname:short)"])) || "";
  const branches = raw.split("\n").map((s) => s.trim()).filter(Boolean);
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

// ---------------------------------------------------------------- HTTP: proxy + control
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Resolve which running version serves this request. The pin cookie holds "preview"
// or a branch name; it is only honored while the preview is "ready" (a still-
// building or dead preview falls back to base, never a 502).
function pinnedVersion(req) {
  const pin = parseCookies(req)[PIN_COOKIE];
  if (!pin || pin === "base") return base;
  if (preview && preview.state === "ready" && (pin === "preview" || preview.branch === pin)) return preview;
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
    if (sub === "preview-changes" || sub === "next-changes") return sendJson(res, await previewChanges());
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
      if (v === "base") return sendJson(res, { ok: true, pinned: "base" }, 200, clearPin);
      if (preview && preview.state === "ready" && (v === "preview" || preview.branch === v)) {
        return sendJson(res, { ok: true, pinned: v }, 200, { "Set-Cookie": `${PIN_COOKIE}=${encodeURIComponent(v)}; Path=/; HttpOnly` });
      }
      return sendJson(res, { ok: false, error: `version "${v}" not previewable` }, 400);
    }
    if (sub === "begin" && req.method === "POST") {
      const branch = body.branch ? String(body.branch) : undefined;
      const v = await beginPreview(branch);
      return sendJson(res, { ok: true, branch: v.branch, worktree: v.worktree });
    }
    if (sub === "build" && req.method === "POST") {
      if (!preview) return sendJson(res, { ok: false, error: "no preview" }, 400);
      const state = await buildPreview({ sessionId });
      return sendJson(res, { ok: state === "ready", state, ...(preview && preview.buildError ? { error: preview.buildError } : {}), ...(preview && preview.buildLog ? { buildLog: preview.buildLog } : {}) });
    }
    if (sub === "activate" && req.method === "POST") {
      const branch = String(body.branch || "");
      const result = await activate(branch);
      const cookie = !branch || branch === baseBranch
        ? clearPin
        : { "Set-Cookie": `${PIN_COOKIE}=${encodeURIComponent(branch)}; Path=/; HttpOnly` };
      return sendJson(res, { ok: true, ...result }, 200, cookie);
    }
    if (sub === "promote" && req.method === "POST") return sendJson(res, { ok: true, ...(await promote()) }, 200, clearPin);
    // discard / stop are the same action now: kill + clean the preview, back to base.
    if ((sub === "discard" || sub === "stop") && req.method === "POST") { await dropPreview(); return sendJson(res, { ok: true }, 200, clearPin); }
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
  <button onclick="act('pin',{version:'preview'})">Preview</button>
  <button onclick="act('pin',{version:'base'})">Back to base</button>
</div>
<div class="row">
  <button onclick="act('build')">Build preview</button>
  <button onclick="act('promote')">Promote</button>
  <button onclick="act('discard')">Stop / discard</button>
  <button onclick="act('push')">Push to remote</button>
  <button onclick="refresh()">Refresh</button>
</div>
<pre id="state">loading…</pre>
<script>
async function refresh(){const r=await fetch('/__supervisor/state');document.getElementById('state').textContent=JSON.stringify(await r.json(),null,2);}
async function act(p,b){const r=await fetch('/__supervisor/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});const j=await r.json();if(j.pinned!==undefined){location.href='/';return;}alert(JSON.stringify(j));refresh();}
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

  if (REUSE_BASE_PORT) {
    base = { role: "base", port: REUSE_BASE_PORT, state: "ready", reused: true, branch: baseBranch, commit: await gitTry(["rev-parse", "HEAD"]) };
    log(`reusing existing server on :${REUSE_BASE_PORT} as base (dev mode)`);
    if (!(await probeOnce(REUSE_BASE_PORT))) {
      log(`WARNING: nothing is responding on :${REUSE_BASE_PORT}. Reuse mode proxies base there — start \`npm run dev\` on :${REUSE_BASE_PORT} first, or omit BOS_ACTIVE_REUSE_PORT so the Supervisor builds + serves base itself.`);
    }
  } else {
    await buildAndStartBase(await git(["rev-parse", "HEAD"]));
  }

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
