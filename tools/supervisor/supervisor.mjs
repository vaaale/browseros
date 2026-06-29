#!/usr/bin/env node
// BrowserOS Supervisor — the stable control plane for live version control
// (specs/005-self-modification/spec.md, run-model A).
//
// It owns the PUBLIC port and reverse-proxies to internal `next` instances
// (active / next / previous), each launched from its own git worktree on its
// own port with its own BOS_DATA_DIR. It serves the version-independent
// /__supervisor control surface (state · preview-pin · promote · rollback ·
// discard · push) so the running OS can be swapped safely.
//
// Standalone & dependency-light (Node built-ins only): the Supervisor is the
// trusted kernel and is NOT itself self-modified. Run: `npm run supervisor`.

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

// ---------------------------------------------------------------- config
const REPO = process.env.BOS_REPO || process.cwd();
const PUBLIC_PORT = Number(process.env.BOS_PUBLIC_PORT || 8080);
const PORT_BASE = Number(process.env.BOS_PORT_BASE || 3100);
let baseBranch = process.env.BOS_BASE_BRANCH || "";             // resolved to current branch at startup
const WORKTREES = process.env.BOS_WORKTREES || path.join(path.dirname(REPO), "bos-worktrees");
const CANONICAL_DATA = process.env.BOS_CANONICAL_DATA || path.join(REPO, "data");
const CLONES = process.env.BOS_DATA_CLONES || path.join(path.dirname(REPO), "bos-data-clones");
const PUSH_MODE = process.env.BOS_PUSH_MODE || "manual";        // manual | auto-on-promote
const REMOTE = process.env.BOS_REMOTE || "origin";
const HEALTH_TIMEOUT_MS = Number(process.env.BOS_HEALTH_TIMEOUT_MS || 120_000);
// Reuse an already-running server as `active` (dev convenience / testing).
const REUSE_ACTIVE_PORT = process.env.BOS_ACTIVE_REUSE_PORT ? Number(process.env.BOS_ACTIVE_REUSE_PORT) : null;
const PORTS = { active: PORT_BASE, previous: PORT_BASE + 1, next: PORT_BASE + 2 };
const PIN_COOKIE = "bos_pin";

// Apps content repo (GitFS) — versioned user apps, a standalone repo independent
// of BOS source. App candidates are git BRANCHES here (not worktrees + a second
// server): the active BOS serves the apps repo's working tree, so checking out
// the candidate branch makes the in-progress app visible ("branch-live" preview),
// promote merges it to the base branch, discard drops it. This is orthogonal to
// the BOS-code candidate flow above and needs no extra port/proxy.
const APPS_REPO = process.env.BOS_APPS_DIR || path.join(REPO, "apps");
const APP_CANDIDATE_BRANCH = "app-candidate";
const GIT_IDENTITY = ["-c", "user.name=BrowserOS", "-c", "user.email=bos@localhost"];
/** @type {{branch:string, base:string}|null} */
let appCandidate = null;

const log = (...a) => console.log("[supervisor]", ...a);

// ---------------------------------------------------------------- version registry
/** @typedef {{role:string,branch?:string,worktree?:string,dataDir?:string,port:number,state:string,proc?:import('node:child_process').ChildProcess|null,commit?:string,tag?:string,reused?:boolean,tests?:string}} Version */
/** @type {{active:Version|null, next:Version|null, previous:Version|null}} */
const versions = { active: null, next: null, previous: null };

// Resolve a version's branch live from its working dir so renames, merges, and
// branch switches are reflected in the UI rather than the value captured when
// the version was first registered. The reused active serves from the main repo
// (no worktree); worktree-backed versions resolve from their own worktree.
async function liveBranch(v) {
  if (!v) return undefined;
  return (await gitTry(["rev-parse", "--abbrev-ref", "HEAD"], v.worktree || REPO)) || v.branch;
}
async function publicState() {
  const pick = async (v) =>
    v ? { role: v.role, branch: await liveBranch(v), port: v.port, state: v.state, commit: v.commit, tag: v.tag, tests: v.tests, reused: !!v.reused } : null;
  const [active, next, previous] = await Promise.all([pick(versions.active), pick(versions.next), pick(versions.previous)]);
  return { active, next, previous, appCandidate, pushMode: PUSH_MODE, baseBranch };
}

// ---------------------------------------------------------------- git
async function git(args, cwd = REPO) {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
async function gitTry(args, cwd = REPO) {
  try { return await git(args, cwd); } catch { return null; }
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
async function ensureWorktree(role, commit) {
  const wt = path.join(WORKTREES, role);
  await gitTry(["worktree", "remove", "--force", wt]);
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  const branch = `bos/${role}-${Date.now().toString(36)}`;
  await fs.mkdir(WORKTREES, { recursive: true });
  await git(["worktree", "add", "-b", branch, wt, commit]);
  await hydrateWorktree(wt);
  return { wt, branch };
}

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

// Check out an EXISTING branch into the `next` worktree (vs ensureWorktree, which
// creates a fresh bos/<role>-* branch off a commit). Used to serve an arbitrary
// branch selected from the toolbar's branch dropdown.
async function ensureWorktreeForBranch(branch) {
  const wt = path.join(WORKTREES, "next");
  await gitTry(["worktree", "remove", "--force", wt]);
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(WORKTREES, { recursive: true });
  await git(["worktree", "add", wt, branch]);
  await hydrateWorktree(wt);
  return { wt, branch };
}

function startProc(v) {
  v.proc = spawn("npx", ["next", "start", "-p", String(v.port)], {
    cwd: v.worktree,
    env: { ...process.env, PORT: String(v.port), BOS_DATA_DIR: v.dataDir, BOS_VERSION_LABEL: v.role },
    stdio: "inherit",
  });
  v.proc.on("exit", (code) => log(`version "${v.role}" process exited (${code})`));
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

/** Build a candidate worktree (own .next), start it, and health-gate it. */
async function buildAndStart(v) {
  // Commit the worktree's changes onto the candidate branch so a later promote
  // can fast-forward them into the base branch — the agent's edits live in the
  // worktree's working tree, and without a commit there's nothing to merge.
  await git(["add", "-A"], v.worktree).catch(() => {});
  await git(["commit", "-m", `BOS candidate (${v.role})`], v.worktree).catch(() => {});
  v.commit = await git(["rev-parse", "HEAD"], v.worktree).catch(() => v.commit);
  v.state = "building";
  log(`building ${v.role} @ ${v.worktree} (commit ${String(v.commit).slice(0, 8)})`);
  await exec("npm", ["run", "build"], { cwd: v.worktree, env: process.env, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 });
  startProc(v);
  v.state = (await waitHealthy(v.port)) ? "ready" : "failed";
  log(`${v.role} → ${v.state}`);
  return v.state;
}

function stopProc(v) {
  if (v?.proc && !v.proc.killed) { try { v.proc.kill("SIGTERM"); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- operations
/** Provision a fresh `next` candidate worktree (off active's HEAD) + data clone. */
async function beginNext() {
  // Idempotent: reuse an existing candidate instead of tearing it down. Repeated
  // dev runs accumulate into the same `next`; Discard/Promote clears it so the
  // next task starts fresh. (Prevents wiping a candidate you're previewing.)
  if (versions.next) {
    log(`begin: reusing existing candidate ${versions.next.branch}`);
    return versions.next;
  }
  const commit = versions.active?.commit || (await git(["rev-parse", "HEAD"]));
  const { wt, branch } = await ensureWorktree("next", commit);
  const clone = path.join(CLONES, "next");
  await provisionClone(clone);
  versions.next = { role: "next", branch, worktree: wt, dataDir: clone, port: PORTS.next, state: "idle", proc: null, commit };
  log(`begin: next worktree ${branch} @ ${commit.slice(0, 8)}`);
  return versions.next;
}

/** Promote `next` → active: git ff-merge into the base branch, tag, optional push,
 *  restart on canonical data (code-only), flip routing, retain previous, drain. */
async function promote() {
  const cand = versions.next;
  if (!cand || cand.state !== "ready") throw new Error("no ready candidate to promote");
  const candCommit = await git(["rev-parse", "HEAD"], cand.worktree);

  // Preconditions (fail early with an actionable message rather than letting the
  // ff-merge below abort cryptically — the failure that made "Promote" look dead):
  //  - The base checkout (REPO) must be clean. promote runs `git checkout base` +
  //    `git merge --ff-only` here; an in-place edit (e.g. the agent editing the
  //    main checkout instead of the candidate worktree) leaves it dirty and the
  //    merge aborts with "local changes would be overwritten".
  const dirty = await gitTry(["status", "--porcelain"], REPO);
  if (dirty) {
    throw new Error(
      `base checkout (${REPO}) has uncommitted changes — commit, stash, or discard them before promoting:\n${dirty}`,
    );
  }
  //  - The candidate must fast-forward the base (gitTry → "" when baseBranch is an
  //    ancestor of candCommit, null when `--is-ancestor` exits non-zero).
  if ((await gitTry(["merge-base", "--is-ancestor", baseBranch, candCommit], REPO)) === null) {
    throw new Error(`candidate ${cand.branch} is not a fast-forward of ${baseBranch}; rebase it onto ${baseBranch} before promoting.`);
  }

  // Git integration: fast-forward the base branch to the candidate's commit.
  await git(["checkout", baseBranch], REPO);
  await git(["merge", "--ff-only", candCommit], REPO);
  const tag = `bos/v${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  await git(["tag", "-a", tag, "-m", `promote ${cand.branch}`], REPO);
  if (PUSH_MODE === "auto-on-promote") {
    await gitTry(["push", REMOTE, baseBranch, "--follow-tags"], REPO);
  }

  // Code-only at the data layer: the new active runs the candidate's code but
  // against the CANONICAL data dir (the preview clone is discarded). Restart the
  // candidate worktree's server on canonical data.
  stopProc(cand);
  const newActive = { role: "active", branch: cand.branch, worktree: cand.worktree, dataDir: CANONICAL_DATA, port: PORTS.active, state: "ready", commit: candCommit, tag };
  startProc(newActive);
  await waitHealthy(newActive.port);

  // Drain: keep the old active as `previous` (still serving in-flight) for rollback.
  stopProc(versions.previous); // reap the older previous, if any
  versions.previous = versions.active;
  if (versions.previous) versions.previous.role = "previous";
  versions.active = newActive;
  // Discard the candidate's data clone (code-only promote).
  await fs.rm(cand.dataDir, { recursive: true, force: true }).catch(() => {});
  versions.next = null;
  log(`promoted ${cand.branch} → active (tag ${tag})`);
  return { tag };
}

/** Roll back to the retained previous version (instant drain-and-flip). */
async function rollback() {
  if (!versions.previous) throw new Error("no previous version to roll back to");
  const reinstated = versions.previous;
  reinstated.role = "active";
  versions.previous = versions.active && versions.active !== reinstated ? versions.active : null;
  if (versions.previous) versions.previous.role = "previous";
  versions.active = reinstated;
  log("rolled back to previous");
  return { active: reinstated.branch };
}

/** Discard the current candidate (stop it, drop its worktree + data clone). */
async function discard() {
  const cand = versions.next;
  if (!cand) return;
  stopProc(cand);
  await gitTry(["worktree", "remove", "--force", cand.worktree], REPO);
  await fs.rm(cand.dataDir, { recursive: true, force: true }).catch(() => {});
  versions.next = null;
  log("discarded candidate");
}

/** Files changed on the `next` candidate vs the base branch. The agent's edits are
 *  COMMITTED in the candidate worktree (buildAndStart), so the main checkout looks
 *  clean — this surfaces the real change so the assistant's gitStatus isn't fooled
 *  into thinking nothing happened. */
async function nextChanges() {
  const cand = versions.next;
  if (!cand) return { ok: true, candidate: null };
  const raw = (await gitTry(["diff", "--name-status", `${baseBranch}...HEAD`], cand.worktree)) || "";
  const files = raw
    ? raw.split("\n").filter(Boolean).map((l) => {
        const tab = l.indexOf("\t");
        return tab < 0 ? { status: l.trim(), path: "" } : { status: l.slice(0, tab).trim(), path: l.slice(tab + 1) };
      })
    : [];
  return { ok: true, candidate: { branch: await liveBranch(cand), base: baseBranch, state: cand.state, commit: cand.commit, files } };
}

/** Branches selectable from the toolbar dropdown — real branches only, hiding
 *  the internal bos/* worktree branches the Supervisor creates. Base is always
 *  present so the active version is always selectable. */
async function listBranches() {
  const raw = (await gitTry(["branch", "--format=%(refname:short)"])) || "";
  const branches = raw.split("\n").map((s) => s.trim()).filter((b) => b && !b.startsWith("bos/"));
  if (!branches.includes(baseBranch)) branches.unshift(baseBranch);
  return branches;
}

/** Activate a branch from the toolbar dropdown: base → drop any candidate and
 *  return to the active version; otherwise (re)provision `next` from that branch
 *  and build it in the background. handleControl pins the session via Set-Cookie;
 *  pinnedVersion only routes to it once the build reports ready. */
async function activate(branch) {
  await discard();
  if (!branch || branch === baseBranch) return { base: true };
  const { wt } = await ensureWorktreeForBranch(branch);
  const clone = path.join(CLONES, "next");
  await provisionClone(clone);
  const v = {
    role: "next", branch, worktree: wt, dataDir: clone, port: PORTS.next,
    state: "building", proc: null, commit: await gitTry(["rev-parse", "HEAD"], wt),
  };
  versions.next = v;
  void buildAndStart(v).catch((e) => { v.state = "failed"; log(`activate build failed: ${e.message || e}`); });
  return { branch, state: "building" };
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

/** Begin (or reuse) the app candidate: a branch in the apps repo, checked out so
 *  the active server serves it. Idempotent — repeated builds accumulate here. */
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

/** Promote the app candidate: merge its branch into base, delete the branch. */
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

/** Discard the app candidate: return to base and drop the branch (app gone). */
async function appDiscard() {
  if (!appCandidate) return { discarded: false };
  const { base } = appCandidate;
  await gitTry(["checkout", "-f", base], APPS_REPO);
  await gitTry(["branch", "-D", APP_CANDIDATE_BRANCH], APPS_REPO);
  appCandidate = null;
  log("app candidate discarded");
  return { discarded: true };
}

/** Push the canonical base branch + tags to the remote (manual action). */
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

// Resolve which running version this request should be served by. The pin cookie
// holds either a role ("next"/"previous", set by the /__supervisor control page)
// or a branch name (set when a branch is activated from the toolbar dropdown). A
// pin is only honored while its version is "ready"; otherwise we fall back to
// active so a still-building candidate never serves 502s to a pinned session.
function pinnedVersion(req) {
  const pin = parseCookies(req)[PIN_COOKIE];
  if (!pin || pin === "active") return versions.active;
  if (versions[pin] && versions[pin].state === "ready") return versions[pin];
  for (const v of [versions.next, versions.previous, versions.active]) {
    if (v && v.state === "ready" && v.branch === pin) return v;
  }
  return versions.active;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
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
        `<p>In <b>reuse</b> mode the active version proxies to an existing server — make sure <code>npm run dev</code> is running on that port. ` +
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
  if (req.method === "GET" && (sub === "" || sub === "state" || sub === "branches" || sub === "next-changes")) {
    if (sub === "") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(controlPage()); return; }
    if (sub === "branches") return sendJson(res, { ok: true, branches: await listBranches(), base: baseBranch });
    if (sub === "next-changes") return sendJson(res, await nextChanges());
    // state — include which version THIS session is being served (the pin cookie),
    // so the toolbar can tell "you're viewing the candidate" from "a candidate
    // exists but you're still on active".
    const st = await publicState();
    const sv = pinnedVersion(req);
    return sendJson(res, { ...st, serving: sv ? { role: sv.role, branch: await liveBranch(sv) } : null });
  }
  const body = await readBody(req);
  const clearPin = { "Set-Cookie": `${PIN_COOKIE}=; Path=/; Max-Age=0` };
  try {
    if (sub === "pin" && req.method === "POST") {
      const role = String(body.version || "active");
      if (role === "active" || (versions[role] && versions[role].state === "ready")) {
        const clear = role === "active";
        return sendJson(res, { ok: true, pinned: role }, 200, {
          "Set-Cookie": clear ? `${PIN_COOKIE}=; Path=/; Max-Age=0` : `${PIN_COOKIE}=${role}; Path=/; HttpOnly`,
        });
      }
      return sendJson(res, { ok: false, error: `version "${role}" not previewable` }, 400);
    }
    if (sub === "begin" && req.method === "POST") return sendJson(res, await beginNext().then((v) => ({ ok: true, branch: v.branch, worktree: v.worktree })));
    if (sub === "build" && req.method === "POST") {
      if (!versions.next) return sendJson(res, { ok: false, error: "no candidate" }, 400);
      return sendJson(res, { ok: true, state: await buildAndStart(versions.next) });
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
    if (sub === "rollback" && req.method === "POST") return sendJson(res, { ok: true, ...(await rollback()) }, 200, clearPin);
    if (sub === "discard" && req.method === "POST") { await discard(); return sendJson(res, { ok: true }, 200, clearPin); }
    if (sub === "app-begin" && req.method === "POST") return sendJson(res, { ok: true, ...(await appBegin()) });
    if (sub === "app-promote" && req.method === "POST") return sendJson(res, { ok: true, ...(await appPromote()) });
    if (sub === "app-discard" && req.method === "POST") return sendJson(res, { ok: true, ...(await appDiscard()) });
    if (sub === "push" && req.method === "POST") return sendJson(res, { ok: true, ...(await pushNow()) });
  } catch (e) {
    return sendJson(res, { ok: false, error: String(e.message || e) }, 500);
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
  <button onclick="act('pin',{version:'next'})">Preview next</button>
  <button onclick="act('pin',{version:'previous'})">Preview previous</button>
  <button onclick="act('pin',{version:'active'})">Back to active</button>
</div>
<div class="row">
  <button onclick="act('build')">Build candidate</button>
  <button onclick="act('promote')">Promote</button>
  <button onclick="act('rollback')">Rollback</button>
  <button onclick="act('discard')">Discard</button>
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

  if (REUSE_ACTIVE_PORT) {
    versions.active = { role: "active", port: REUSE_ACTIVE_PORT, state: "ready", reused: true, branch: baseBranch, commit: await gitTry(["rev-parse", "HEAD"]) };
    log(`reusing existing server on :${REUSE_ACTIVE_PORT} as active (dev mode)`);
    if (!(await probeOnce(REUSE_ACTIVE_PORT))) {
      log(`WARNING: nothing is responding on :${REUSE_ACTIVE_PORT}. Reuse mode proxies the active version there — start \`npm run dev\` on :${REUSE_ACTIVE_PORT} first, or omit BOS_ACTIVE_REUSE_PORT so the Supervisor builds + serves active itself.`);
    }
  } else {
    const commit = await git(["rev-parse", "HEAD"]);
    const { wt, branch } = await ensureWorktree("active", commit);
    versions.active = { role: "active", branch, worktree: wt, dataDir: CANONICAL_DATA, port: PORTS.active, state: "idle", commit };
    await buildAndStart(versions.active);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/__supervisor" || url.pathname.startsWith("/__supervisor/")) {
      const sub = url.pathname === "/__supervisor" ? "" : url.pathname.slice("/__supervisor/".length);
      void handleControl(req, res, sub);
      return;
    }
    const port = pinnedVersion(req)?.port;
    if (!port) { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("No active version"); return; }
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

  server.listen(PUBLIC_PORT, () => log(`listening on :${PUBLIC_PORT} (base branch: ${baseBranch}); control at /__supervisor`));
}

main().catch((e) => { console.error("[supervisor] fatal:", e); process.exit(1); });
