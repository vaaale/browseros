import { promises as fs } from "node:fs";
import path from "node:path";
import { clonePath, FEATURE_BRANCH_PREFIX, APPS_REPO, REPO, CANONICAL_DATA } from "./config.mjs";
import { git, refExists, mutate, isFeatureBranch, requireFeatureBranch } from "./gitutil.mjs";
import { addWorktreeForBranch, provisionClone } from "./worktree.mjs";
import { mountCoupled, discardCoupled, coupledReposFor, specStoreReposFor, listSpecStores } from "./coupled-repos.mjs";
import { buildAndStart } from "./build.mjs";
import { startProc, stopProc, waitHealthy, allocPreviewPort } from "./proc.mjs";
import { state, previews, previewProvisioning } from "./state.mjs";
import { log, slog } from "./log.mjs";
import { fetchOriginWithAuth } from "./git-auth.mjs";

/**
 * Symlink the CODE worktree's own `data/user-apps` at the properly
 * branch-coupled worktree mountCoupled just (re)mounted. Without this, a
 * developer sub-agent — which only ever operates inside its worktree, and
 * has no reason to know about BOS_DATA_CLONES or any running server's API —
 * will naturally reach for the path that looks right,
 * `data/user-apps/items/<id>/`, relative to its own working directory. That
 * path is otherwise a plain, gitignored, disconnected directory: never read
 * by any running server, never git-tracked, and wiped the moment the
 * worktree is torn down (`git worktree remove`) — which is exactly how a
 * marketplace app built this way is silently lost on promote/discard, even
 * with user-apps itself now correctly branch-coupled.
 *
 * With the symlink in place, writing to that natural relative path IS
 * writing into the same git worktree the running preview server,
 * promoteCoupled, and discardCoupled all use — no special-cased path or API
 * call required. Idempotent; safe to call on every mount.
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

async function mountAllCoupled(worktree, dataDir, branch, logComponent) {
  for (const repo of await coupledReposFor(worktree, dataDir)) {
    await mountCoupled(repo, repo.dst, branch).catch((e) =>
      slog("warn", logComponent, `${repo.id} mount failed for ${branch}: ${e?.message || e}`, { branch }),
    );
  }
  await linkUserAppsIntoWorktree(worktree, dataDir).catch((e) =>
    slog("warn", logComponent, `user-apps worktree link failed for ${branch}: ${e?.message || e}`, { branch }),
  );
}

// On startup, scan git for bos/* feature branches and re-provision their
// worktrees. Runtime state is intentionally not persisted: restored previews
// are treated as not-built and can be rebuilt or resumed explicitly.
export async function restorePreviews() {
  const raw = await git(["branch", "--list", `${FEATURE_BRANCH_PREFIX}*`, "--format=%(refname:short)"]).catch(() => "");
  const branches = raw.split("\n").map((s) => s.trim()).filter((s) => s && s !== "HEAD");
  if (!branches.length) return;
  for (const branch of branches) {
    if (!isFeatureBranch(branch, state.baseBranch)) continue;
    if (previews.has(branch)) continue; // already provisioned during this run
    try {
      const wt = await addWorktreeForBranch(branch);
      const clone = clonePath(branch);
      await provisionClone(clone);
      await mountAllCoupled(wt, clone, branch, "restore");
      const port = await allocPreviewPort();
      let commit;
      try { commit = await git(["rev-parse", "HEAD"], wt); } catch { commit = undefined; }
      const p = { role: "preview", branch, worktree: wt, dataDir: clone, port, state: "not-built", proc: null, commit };
      previews.set(branch, p);
      log(`restored preview ${branch} (not-built) on port ${port}`);
    } catch (e) {
      slog("warn", "restore", `failed to restore preview ${branch}: ${e.message || e}`, {});
    }
  }
  if (previews.size) log(`restored ${previews.size} preview(s) from git branches`);
}

// Provision a PREVIEW for `branch`: branch-named worktree + data clone + a
// pooled port. An existing branch is checked out with its committed
// history; a missing branch is created off base. Does NOT build — the
// developer agent edits the worktree, then /build runs.
//
// The "already provisioned?" check and the `previews.set()` that answers it
// are separated by several awaits (worktree add, data clone, port alloc) —
// without serialization, two calls for the same not-yet-provisioned branch
// arriving close together (e.g. two dev-harness runs starting back to back)
// would both see no existing preview and both race addWorktreeForBranch's
// worktree remove/add on the same path. previewProvisioning makes every
// caller for a given branch await the SAME in-flight provision instead of
// starting a second one.
export async function provisionPreview(branch) {
  requireFeatureBranch(branch, state.baseBranch);
  const existing = previews.get(branch);
  if (existing) return existing;
  const inFlight = previewProvisioning.get(branch);
  if (inFlight) return inFlight;
  const work = _provisionPreview(branch);
  previewProvisioning.set(branch, work);
  try {
    return await work;
  } finally {
    previewProvisioning.delete(branch);
  }
}

// Reads git-remotes.json directly (Node built-ins only — the Supervisor is a
// standalone, dependency-light script and does not import from src/lib; same
// pattern as push.mjs's runAutoPush). Legacy remotes with no `filesystem` tag
// belong to the BrowserOS source repo (src/lib/gitops/remote-config.ts's own
// convention), same as one explicitly tagged "bos-src".
export async function firstSourceRemote() {
  const configPath = path.join(CANONICAL_DATA, "config", "git-remotes.json");
  let configs;
  try {
    configs = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") slog("warn", "begin", `reading git-remotes.json (${configPath}) failed: ${e?.message || e}`);
    return null;
  }
  return (Array.isArray(configs) ? configs : []).find((r) => !r.filesystem || r.filesystem === "bos-src") ?? null;
}

// "MUST pull before creating a new branch" — only applies to a NEW branch
// (never when resuming one that already exists), and only when a remote is
// actually configured; a fresh BOS instance with no remote is unaffected.
// fetchOriginWithAuth resolves a stored credential the same way
// bastion/src/secrets-reader.ts does (the Supervisor is likewise a
// standalone Node process with no import access to src/lib's SecretsStore,
// but shares the same `data/` directory), refreshing it first if it's
// expired/expiring and retrying once more if GitLab still rejects it — a
// bare, unauthenticated `git fetch` against a private remote fails
// immediately with "could not read Username for '<host>'", and an expired
// token fails with "Authentication failed" until something refreshes it.
export async function pullBaseBeforeNewBranch() {
  const remote = await firstSourceRemote();
  if (!remote) return;
  await fetchOriginWithAuth(CANONICAL_DATA, git, remote, ["fetch", remote.name, state.baseBranch], REPO);
  await git(["merge", "--ff-only", `${remote.name}/${state.baseBranch}`]);
}

async function _provisionPreview(branch) {
  const existing = previews.get(branch);
  if (existing) return existing;
  if (!(await refExists(REPO, `refs/heads/${branch}`))) {
    await pullBaseBeforeNewBranch();
    const from = state.base?.commit || (await git(["rev-parse", "HEAD"]));
    await git(["branch", branch, from]);
  }
  const wt = await addWorktreeForBranch(branch);
  const clone = clonePath(branch);
  await provisionClone(clone);
  for (const repo of await coupledReposFor(wt, clone)) {
    if (repo.kind === "user-apps") await mountCoupled(repo, repo.dst, branch);
  }
  await linkUserAppsIntoWorktree(wt, clone);
  const port = await allocPreviewPort();
  let commit;
  try { commit = await git(["rev-parse", "HEAD"], wt); } catch { commit = undefined; }
  const p = { role: "preview", branch, worktree: wt, dataDir: clone, port, state: "not-built", proc: null, commit };
  previews.set(branch, p);
  log(`preview ${branch} provisioned on port ${port}`);
  return p;
}

// Stop a preview's server but KEEP the worktree, branch, and data clone.
export async function stopPreview(branch) {
  requireFeatureBranch(branch, state.baseBranch);
  const p = previews.get(branch);
  if (!p) return;
  await stopProc(p);
  p.state = "stopped";
  p.proc = null;
  log(`stopped preview ${p.branch} (worktree + branch kept)`);
}

// Destroy a preview entirely: stop server, remove worktree + data clone,
// DELETE the feature branch. Only called on explicit Discard or after a
// successful Promote. Every coupled-repo cleanup failure and every
// worktree/branch cleanup failure is collected into `warnings` (never just
// logged and dropped) and returned, so a caller (the /discard route) can
// surface "discarded, but: ..." instead of a false all-clear.
export async function discardPreview(branch) {
  requireFeatureBranch(branch, state.baseBranch);
  const warnings = [];
  const p = previews.get(branch);
  previews.delete(branch);
  if (!p) {
    for (const s of await listSpecStores()) await discardCoupled(s, branch, null, warnings);
    await discardCoupled({ id: "user-apps", root: APPS_REPO, kind: "user-apps" }, branch, null, warnings);
    log(`discarded preview ${branch} (branch deleted)${warnings.length ? ` — warnings: ${warnings.join("; ")}` : ""}`);
    return { warnings };
  }
  await stopProc(p);
  for (const repo of await coupledReposFor(p.worktree, p.dataDir)) {
    await discardCoupled(repo, branch, repo.dst, warnings);
  }
  await mutate(`remove preview worktree ${p.worktree}`, () => git(["worktree", "remove", "--force", p.worktree]), warnings);
  await mutate(`remove data clone ${p.dataDir}`, () => fs.rm(p.dataDir, { recursive: true, force: true }), warnings);
  await mutate(`delete branch ${p.branch}`, () => git(["branch", "-D", p.branch]), warnings);
  log(`discarded preview ${p.branch} (branch deleted)${warnings.length ? ` — warnings: ${warnings.join("; ")}` : ""}`);
  return { warnings };
}

export async function beginPreview(branch) {
  const p = await provisionPreview(branch);
  // (Re)mount the store worktrees on every begin — fresh provision or
  // reuse — so the harness reads/writes specs on the feature branch at
  // `specs/<store>/…`. A per-store failure doesn't abort begin (other
  // stores may still be fine, and the code worktree itself is unaffected)
  // but must be traceable back to WHICH store failed and why — silently
  // logging it as a warning and returning success regardless is exactly the
  // kind of fall-through that turned a real "GitLab auth failed" into a
  // caller-facing "may be busy, retry" guess.
  const mountErrors = {};
  for (const repo of await specStoreReposFor(p.worktree)) {
    await mountCoupled(repo, repo.dst, branch).catch((e) => {
      const msg = e?.message || String(e);
      slog("warn", "begin", `spec mount failed for ${branch}: ${msg}`, { branch });
      mountErrors[repo.id] = msg;
    });
  }
  return Object.keys(mountErrors).length ? { ...p, mountErrors } : p;
}

export async function buildPreview(branch, ctx = {}) {
  const p = previews.get(requireFeatureBranch(branch, state.baseBranch)) || (await provisionPreview(branch));
  return await buildAndStart(p, ctx);
}

// Toolbar branch selection. Base only clears the pin. A ready preview can be
// pinned immediately. Missing/not-built/stopped previews are provisioned and
// built in the background; the current request keeps serving base until
// Preview pins it.
export async function activate(branch, ctx = {}) {
  if (!branch || branch === state.baseBranch) return { base: true, state: "ready" };
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

// Resume a STOPPED preview: start its server from the existing build output
// (no rebuild). Falls back to a full buildAndStart if the server doesn't
// come up (e.g. the .next output was deleted). Throws on failure.
export async function resumePreview(branch) {
  const p = previews.get(requireFeatureBranch(branch, state.baseBranch));
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

// Resolve a version's branch live from its working dir so renames/merges are
// reflected rather than the value captured at registration.
export async function liveBranch(v) {
  if (!v) return undefined;
  let b;
  try {
    b = await git(["rev-parse", "--abbrev-ref", "HEAD"], v.worktree);
  } catch (e) {
    slog("warn", "state", `could not read live branch for ${v.role} at ${v.worktree}: ${e?.message || e}`, { branch: v.branch });
    b = undefined;
  }
  // Base runs directly from REPO, normally checked out on baseBranch, so
  // this reads "HEAD" literally only in an unusual transient state (mid-
  // checkout, or genuinely detached). Fall back to the version's logical
  // branch (base → baseBranch) either way, so the toolbar shows/selects the
  // real branch rather than "HEAD" — which otherwise makes base look like a
  // feature selection and leaves the preview buttons active.
  return b && b !== "HEAD" ? b : v.branch || undefined;
}

// Files changed on the preview vs the base branch. The agent's edits are
// COMMITTED in the preview worktree (buildAndStart), so the main checkout
// looks clean — this surfaces the real change so the assistant's gitStatus
// isn't fooled.
export async function previewChanges(branch) {
  const p = branch ? previews.get(branch) : null;
  if (!p) return { ok: true, candidate: null };
  const raw = await git(["diff", "--name-status", `${state.baseBranch}...HEAD`], p.worktree).catch(() => "");
  const files = raw
    ? raw.split("\n").filter(Boolean).map((l) => {
        const tab = l.indexOf("\t");
        return tab < 0 ? { status: l.trim(), path: "" } : { status: l.slice(0, tab).trim(), path: l.slice(tab + 1) };
      })
    : [];
  return { ok: true, candidate: { branch: await liveBranch(p), base: state.baseBranch, state: p.state, commit: p.commit, files } };
}

// All git branches for the toolbar dropdown (including bos/* feature
// branches, so an orphaned preview from a previous run can be re-selected).
// Base is always present.
export async function listBranches() {
  const raw = await git(["branch", "--format=%(refname:short)"]).catch(() => "");
  const branches = raw.split("\n").map((s) => s.trim()).filter((s) => s && s !== "HEAD");
  if (!branches.includes(state.baseBranch)) branches.unshift(state.baseBranch);
  return branches;
}
