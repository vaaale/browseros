import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { WORKTREES, CANONICAL_DATA, REPO, CLONES, FEATURE_BRANCH_PREFIX } from "./config.mjs";
import { git, meaningfulDirtyLines, GIT_IDENTITY, isFeatureBranch } from "./gitutil.mjs";
import { state, previews } from "./state.mjs";
import { slog } from "./log.mjs";
import { mountedSpecStoresIn, commitCoupled } from "./coupled-repos.mjs";

const exec = promisify(execFile);

// ---------------------------------------------------------------- data clone (reads the datafs setting)

/**
 * Run `cp`, keeping only the HEAD of stderr and draining the rest.
 *
 * `execFile`'s maxBuffer was actively harmful here. `cp -al` into a target it
 * cannot hardlink to emits one error line per file — tens of megabytes on a
 * real data dir — which blew the 8 MB buffer, so the rejection Node produced
 * was "stderr maxBuffer length exceeded" and the one line that mattered,
 * "cp: cannot create hard link ...: Invalid cross-device link", was destroyed.
 * On the production box 16 of 20 fallback log entries said the former. A
 * diagnostic that fails under exactly the conditions it exists to diagnose is
 * worse than none.
 */
function runCp(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
    let head = "";
    let timer = null;
    child.stderr.on("data", (chunk) => {
      if (head.length < 4096) head += chunk.toString();
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve();
      const first = head.split("\n").map((l) => l.trim()).find(Boolean);
      reject(new Error(first || `cp failed (${signal ? `signal ${signal}` : `code ${code}`})`));
    });
    timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  });
}

/**
 * The path the clone layer reads the canonical data dir THROUGH.
 *
 * Normally CANONICAL_DATA itself. `BOS_CLONE_SOURCE` overrides it with a
 * second path to that same directory, and exists for one reason: `link(2)`
 * refuses to cross a MOUNT, so a hardlink farm is only possible when the
 * source path and the clone root are under one mount. The bastion binds
 * `…/<user>/data` at /app/data and `…/<user>/data-clones` at /data-clones —
 * two mounts, no hardlinks possible between them, every clone a full copy. One
 * extra bind of the shared parent gives `/bos/data` and `/bos/data-clones`,
 * which ARE under one mount, and BOS keeps using /app/data so no stored
 * absolute path has to change.
 *
 * It is NOT a second data dir. Nothing outside this file may use it, and
 * anything it is pointed at must be the very same directory CANONICAL_DATA
 * names — a different directory here would clone the wrong data.
 *
 * Read per call rather than frozen at import like config.mjs's constants: it
 * is consulted once per provision, and a frozen copy would make the behaviour
 * untestable without a separate process.
 */
function cloneSource() {
  const override = process.env.BOS_CLONE_SOURCE;
  return override && override.trim() ? override.trim() : CANONICAL_DATA;
}

// Whether a file in the clone source can be hardlinked into `dir`, cached per
// (source, dir) pair — a mount layout does not change under a running
// Supervisor.
const hardlinkProbes = new Map();

/**
 * Perform the operation instead of assuming it.
 *
 * `cp -al` needs `link(2)` from CANONICAL_DATA into the clone root, and
 * `link(2)` refuses to cross a MOUNT even when both paths are on the same
 * filesystem. The bastion gives a container `…/data -> /app/data` and
 * `…/data-clones -> /data-clones` as two separate bind mounts, so the hardlink
 * farm could never work there — and nothing checked, so `auto` chose it every
 * time and the catch below silently converted each clone into a full copy of
 * the data dir. One link of one scratch file answers the question in ~1 ms.
 */
async function canHardlinkInto(dir) {
  const source = cloneSource();
  const key = `${source}\u0000${dir}`;
  const known = hardlinkProbes.get(key);
  if (known) return known;
  const stamp = `${process.pid}-${Date.now()}`;
  const src = path.join(source, `.hlprobe-${stamp}`);
  const dst = path.join(dir, `.hlprobe-${stamp}.lnk`);
  let result;
  try {
    await fs.writeFile(src, "x");
    await fs.link(src, dst);
    result = { ok: true };
  } catch (e) {
    result = { ok: false, reason: e?.message || String(e) };
  } finally {
    for (const p of [src, dst]) {
      await fs.rm(p, { force: true }).catch((e) =>
        slog("warn", "provision", `cleanup of hardlink probe file ${p} failed: ${e?.message || e}`),
      );
    }
  }
  hardlinkProbes.set(key, result);
  return result;
}

/** Same question for block cloning: `cp --reflink=always` on one scratch file.
 *  `--reflink=auto` (what the reflink backend uses) degrades to a byte copy in
 *  silence, so without this the "reflink" setting has the same capacity to lie
 *  that "hardlink" did. */
const reflinkProbes = new Map();
async function canReflinkInto(dir) {
  const source = cloneSource();
  const key = `${source}\u0000${dir}`;
  const known = reflinkProbes.get(key);
  if (known) return known;
  const stamp = `${process.pid}-${Date.now()}`;
  const src = path.join(source, `.rlprobe-${stamp}`);
  const dst = path.join(dir, `.rlprobe-${stamp}.clone`);
  let result;
  try {
    await fs.writeFile(src, "x");
    await runCp(["--reflink=always", src, dst], 5_000);
    result = { ok: true };
  } catch (e) {
    result = { ok: false, reason: e?.message || String(e) };
  } finally {
    for (const p of [src, dst]) {
      await fs.rm(p, { force: true }).catch((e) =>
        slog("warn", "provision", `cleanup of reflink probe file ${p} failed: ${e?.message || e}`),
      );
    }
  }
  reflinkProbes.set(key, result);
  return result;
}

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

/**
 * Provision `target` as an isolated clone of CANONICAL_DATA.
 *
 * Returns `{ method, target, degradedFrom?, reason? }` — the method ACTUALLY
 * used, not the one configured. That distinction is the whole point: this
 * function used to return nothing at all while quietly substituting an 8.5 GB
 * byte copy for the metadata-only hardlink farm its caller believed it was
 * getting, once per feature branch, until a production disk filled up. A
 * caller that cannot see the substitution cannot report it or act on it.
 */
/**
 * Written inside a clone as the LAST step before it is renamed into place, so
 * its presence means "this directory is a finished clone" rather than merely
 * "a directory exists here".
 */
export const CLONE_COMPLETE_MARKER = ".bos-clone-complete";

/**
 * Is `target` a finished clone, or just a directory that happens to be there?
 *
 * The staging-and-rename dance keeps a half-finished COPY from ever appearing
 * at `target`, but it cannot stop something else from creating that path.
 * Found in production: `/data-clones/bos/<branch>` holding only `events/`,
 * `user-apps/` and `vfs/` — what `mountCoupled` and a running preview write —
 * after the real clone was deleted from under the in-memory preview record.
 * The old existence check called that "already provisioned", so the preview
 * ran against a data dir with no config, no agents and no installed items,
 * silently and permanently.
 *
 * Returns "absent", "complete", or "incomplete".
 */
async function cloneState(target, source) {
  const entries = await fs.readdir(target).catch((e) => {
    if (e?.code === "ENOENT") return null;
    throw e; // an unreadable clone dir is a real failure, not "no clone"
  });
  if (entries === null) return "absent";
  if (entries.includes(CLONE_COMPLETE_MARKER)) return "complete";

  // No marker. Every clone that existed before the marker did is in this
  // state, so "no marker" cannot simply mean "rebuild" — that would discard a
  // live preview's accumulated data. A clone carrying everything the source
  // carries is complete; one missing entries is the stub above.
  const want = await fs.readdir(source).catch(() => []);
  const have = new Set(entries);
  const missing = want.filter((n) => !have.has(n));
  if (missing.length) {
    slog("warn", "provision", `${target} exists but is missing ${missing.length} of ${want.length} top-level entries (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}) — treating it as an incomplete clone and rebuilding`);
    return "incomplete";
  }
  // Adopt: record the answer so this scan happens once, not on every provision.
  await fs.writeFile(path.join(target, CLONE_COMPLETE_MARKER), "adopted\n").catch((e) =>
    slog("warn", "provision", `could not mark adopted clone ${target} as complete (it will be re-scanned next time): ${e?.message || e}`),
  );
  return "complete";
}

export async function provisionClone(target) {
  // Idempotent: a preview's data-clone persists across Supervisor restarts
  // (it lives on a bind-mounted host directory in the bastion deployment, or
  // just on disk standalone). If it is COMPLETE it may hold data drift from
  // the preview's own testing — never blow it away just because the Supervisor
  // restarted; only a missing or incomplete clone gets (re-)provisioned.
  const parent = path.dirname(target);
  const state = await cloneState(target, cloneSource());
  if (state === "complete") return { method: "existing", target };
  if (state === "incomplete") {
    await fs.rm(target, { recursive: true, force: true });
  }
  await fs.mkdir(parent, { recursive: true });
  const configured = await isolationMethod();
  // "auto" means "the best method that WORKS here", which can only be
  // established by trying it against this exact clone root.
  let method = configured === "auto" ? "hardlink" : configured;
  let degradedFrom;
  let reason;
  const probe = method === "hardlink" ? await canHardlinkInto(parent) : method === "reflink" ? await canReflinkInto(parent) : { ok: true };
  if (!probe.ok) {
    if (configured === "auto") {
      // Not a degradation — `auto` asked for the best available and this is
      // it. Logged at info so the chosen method is never a mystery.
      slog("info", "provision", `${method} isolation is unavailable for ${parent} (${probe.reason}) — using copy`);
    } else {
      // An explicitly configured method that cannot work IS a misconfiguration,
      // and its cost is a full copy of the data dir per branch. Say so at
      // error level AND hand it back, because a warning nobody reads is how
      // this went unnoticed long enough to fill a disk.
      slog("error", "provision", `datafs method "${configured}" cannot be used for ${parent} — every clone will be a FULL COPY of ${cloneSource()}: ${probe.reason}`);
      degradedFrom = configured;
      reason = probe.reason;
    }
    method = "copy";
  }
  const run = (args) => runCp(args);
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
  const source = cloneSource();
  try {
    if (method === "reflink") await run(["-a", "--reflink=auto", source, staging]);
    else if (method === "copy") await run(["-a", source, staging]);
    else await run(["-al", source, staging]);
  } catch (e) {
    // The method was probed as workable a moment ago, so reaching here means
    // something genuinely went wrong mid-clone rather than "this filesystem
    // can't". Still recoverable by copying, but never quietly: the fallback
    // costs a full copy of the data dir and the caller is told it happened.
    reason = e?.message || String(e);
    slog("error", "provision", `${method} clone of ${target} failed after probing as supported — falling back to a FULL COPY of ${source}: ${reason}`);
    degradedFrom = method;
    method = "copy";
    await fs.rm(staging, { recursive: true, force: true }).catch((rmErr) =>
      slog("error", "provision", `cleanup before fallback copy failed for ${staging}: ${rmErr?.message || rmErr}`),
    );
    await run(["-a", source, staging]);
  }
  await retargetUserAppsItemSymlinks(staging, target);
  // Last write before the rename, so the marker can only ever be seen on a
  // clone that is genuinely finished.
  await fs.writeFile(path.join(staging, CLONE_COMPLETE_MARKER), `${method}\n`);
  await fs.rename(staging, target);
  return { method, target, ...(degradedFrom ? { degradedFrom, reason } : {}) };
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
    if (!violated) return { touched: false, branch, dirty: "" }; // fast path — everything is fine

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
    // WHAT was touched, not merely THAT something was. The caller puts this in
    // the error the user actually sees: a build blocked by "the developer
    // harness edited the live checkout" is unactionable on its own, and the
    // files that explain it (`?? mockup-dashboard.png`, `M package-lock.json`)
    // were only ever in the Supervisor's own log, under a different component,
    // from a run that had finished hours earlier.
    return { touched: true, branch, dirty: meaningfulDirty.join("; ") };
  } catch (e) {
    const why = `assertRepoIntegrity check itself failed: ${e.message || e}`;
    slog("error", "safety-gate", why);
    return { touched: true, branch: "(unreadable)", dirty: why };
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
        for (const repo of await mountedSpecStoresIn(wt)) {
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

/**
 * Reclaim worktree DIRECTORIES that git has disowned.
 *
 * The twin of reconcileDataClones, and deliberately not part of
 * reconcileWorktrees: that pass is registration-driven, iterating
 * `git worktree list`, because it safety-COMMITS a dirty worktree before
 * removing it and can only do that for one git still understands.
 *
 * A directory outlives its registration whenever `<repo>/.git/worktrees/<name>`
 * goes away — a re-clone of src/, a pruned registration, a hand-cleaned repo.
 * `git worktree list` then stops reporting it and the boot reaper cannot see
 * it at all. Production carried seventeen such directories, each a full source
 * tree plus a node_modules copy, and every cleanup the operator ran came
 * undone because nothing reclaimed them.
 *
 * Same conservative rule as the clone reaper: a directory is kept for exactly
 * as long as its branch exists. That costs nothing when the branch is alive —
 * `addWorktreeForBranch` already removes a stale directory before recreating
 * it — so the only thing ever deleted is a directory whose branch has gone.
 * Anything git still reports, and anything outside the `bos/<branch>` layout,
 * is left alone.
 */
export async function reconcileWorktreeDirs() {
  const removed = [];
  const prefixDir = path.join(WORKTREES, FEATURE_BRANCH_PREFIX.replace(/\/+$/, ""));

  // Read the registrations FIRST. If this cannot be read, every directory
  // would look unregistered and the sweep would delete live worktrees
  // wholesale — so a failure reclaims nothing.
  const list = await git(["worktree", "list", "--porcelain"]).catch((e) => {
    slog("error", "reconcile", `worktree list failed — reclaiming no worktree directories this boot rather than treating live worktrees as orphans: ${e?.message || e}`);
    return null;
  });
  if (list === null) return { removed };
  const registered = list
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => path.resolve(l.slice("worktree ".length).trim()));

  let entries;
  try {
    entries = await fs.readdir(prefixDir, { withFileTypes: true });
  } catch (e) {
    if (e?.code !== "ENOENT") slog("error", "reconcile", `cannot read the worktree root ${prefixDir} — no directory reclaimed this boot: ${e?.message || e}`);
    return { removed };
  }

  const raw = await git(["branch", "--list", `${FEATURE_BRANCH_PREFIX}*`, "--format=%(refname:short)"]).catch((e) => {
    slog("error", "reconcile", `listing feature branches failed — skipping worktree-directory reclamation rather than guessing which are orphaned: ${e?.message || e}`);
    return null;
  });
  if (raw === null) return { removed };
  const branches = new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(prefixDir, entry.name);
    const branch = `${FEATURE_BRANCH_PREFIX}${entry.name}`;
    if (branch === state.baseBranch) continue;
    // FEATURE_BRANCH_RE forbids a slash after `bos/`, so BOS never creates a
    // nested worktree itself; this prefix test only covers a branch somebody
    // made by hand, where the directory would be the PARENT of a live
    // worktree. The registered-path check below is what actually protects a
    // live worktree, nested or not.
    if (branches.has(branch) || [...branches].some((b) => b.startsWith(`${branch}/`))) continue;
    // Still registered — reconcileWorktrees owns it, and only that pass makes
    // the safety commit that keeps in-flight work.
    if (registered.some((w) => w === full || w.startsWith(`${full}${path.sep}`))) continue;
    try {
      await fs.rm(full, { recursive: true, force: true });
      removed.push(full);
      slog("info", "reconcile", `reclaimed orphaned worktree directory ${full} (git no longer tracks it and no such feature branch exists)`);
    } catch (e) {
      slog("error", "reconcile", `failed to reclaim orphaned worktree directory ${full}: ${e?.message || e}`);
    }
  }
  return { removed };
}

/**
 * Reclaim `bos/*` branches that hold nothing base does not already have.
 *
 * `discardPreview` and `promote` delete the branch they are handed, and that
 * was the Supervisor's ONLY branch deletion. A branch abandoned any other way
 * stayed forever — and each one is a standing invitation to provision another
 * full clone of the data dir. A production box accumulated 21, of which 18
 * were unit-test fixture names leaked in by a suite that reached the live
 * Supervisor (see tests/_no-live-deployment.cjs for that half of the fix).
 *
 * Three conditions, all required, chosen so this cannot eat real work:
 *
 *   1. **Fully merged into base** — nothing on it base lacks. A leaked test
 *      branch is cut from base and never committed to, so it qualifies by
 *      definition; an abandoned feature with commits does not. The deletion
 *      uses `git branch -d`, never `-D`, so git independently refuses an
 *      unmerged branch even if the listing were somehow wrong.
 *   2. **Not checked out in a worktree.**
 *   3. **Not a live preview** in this process. A *dormant* record (registered
 *      by restorePreviews, never materialized) does NOT count — every leaked
 *      branch has one, so treating registration as "in use" would reclaim
 *      nothing.
 *
 * Runs at boot AFTER reconcileWorktrees(), which safety-commits any dirty
 * worktree before removing it. That ordering is load-bearing: work in flight
 * when the Supervisor restarted becomes a commit, which makes its branch
 * unmerged, which protects it here.
 */
export async function reconcileFeatureBranches() {
  const removed = [];
  const base = state.baseBranch;
  if (!base) {
    slog("error", "reconcile", "base branch is unknown — skipping feature-branch reclamation rather than guessing what is merged");
    return { removed };
  }

  const raw = await git(["branch", "--list", `${FEATURE_BRANCH_PREFIX}*`, "--merged", base, "--format=%(refname:short)"]).catch((e) => {
    slog("error", "reconcile", `listing merged feature branches failed — reclaiming none this boot: ${e?.message || e}`);
    return null;
  });
  if (raw === null) return { removed };

  const list = await git(["worktree", "list", "--porcelain"]).catch((e) => {
    slog("error", "reconcile", `worktree list failed — reclaiming no feature branches this boot rather than risking one that is checked out: ${e?.message || e}`);
    return null;
  });
  if (list === null) return { removed };
  const checkedOut = new Set(
    list.split("\n").filter((l) => l.startsWith("branch ")).map((l) => l.slice("branch ".length).trim().replace(/^refs\/heads\//, "")),
  );

  for (const branch of raw.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (branch === base || !isFeatureBranch(branch, base)) continue;
    if (checkedOut.has(branch)) continue;
    if (previews.get(branch)?.provisioned) continue;
    try {
      await git(["branch", "-d", branch]);
      previews.delete(branch); // a dormant record for a branch that no longer exists would still be listed
      removed.push(branch);
      slog("info", "reconcile", `reclaimed feature branch ${branch} (fully merged into ${base}, no worktree, no live preview)`);
    } catch (e) {
      // Never swallowed: `-d` refusing means the branch was NOT what the
      // listing said it was, which is worth knowing.
      slog("error", "reconcile", `failed to reclaim feature branch ${branch}: ${e?.message || e}`);
    }
  }
  return { removed };
}

/**
 * Reclaim data clones that no longer belong to anything.
 *
 * `discardPreview` removes a preview's clone along with its worktree and
 * branch, and `reconcileWorktrees` above clears leftover worktrees on every
 * boot — but a clone whose branch went away by ANY other route (a hand-run
 * `git branch -D`, the usual way to clean up abandoned work) was never
 * reclaimed by anything, and `provisionClone` is deliberately idempotent so it
 * would never overwrite one either. Clones therefore only ever accumulated:
 * 26 GB of them on the production box, next to a staging directory abandoned
 * mid-copy when the disk filled.
 *
 * The rule is narrow on purpose. A clone can hold data the preview itself
 * wrote, so it is kept for exactly as long as its branch exists; only these go:
 *
 *   - `<CLONES>/bos/<name>` with no `bos/<name>` branch (nor any `bos/<name>/…`)
 *   - `*.provisioning` staging dirs, which are never anything but the debris
 *     of an interrupted copy — provisionClone renames one onto its target the
 *     instant it is complete
 *
 * Anything outside the `bos/<branch>` layout is left alone: CLONES is a
 * configurable path, and deleting a user's data is strictly worse than leaking
 * a clone.
 */
export async function reconcileDataClones() {
  const removed = [];
  const prefixDir = path.join(CLONES, FEATURE_BRANCH_PREFIX.replace(/\/+$/, ""));
  let entries;
  try {
    entries = await fs.readdir(prefixDir, { withFileTypes: true });
  } catch (e) {
    // No clones directory yet is the ordinary case on a fresh deployment.
    // Anything else means we cannot tell what is orphaned, which is worth
    // saying rather than silently reclaiming nothing forever.
    if (e?.code !== "ENOENT") slog("error", "reconcile", `cannot read the data-clone root ${prefixDir} — no clone reclaimed this boot: ${e?.message || e}`);
    return { removed };
  }

  const raw = await git(["branch", "--list", `${FEATURE_BRANCH_PREFIX}*`, "--format=%(refname:short)"]).catch((e) => {
    slog("error", "reconcile", `listing feature branches failed — skipping data-clone reclamation this boot rather than guessing which clones are orphaned: ${e?.message || e}`);
    return null;
  });
  // A failed listing must NOT read as "no branches exist" — that would reclaim
  // every clone on the box.
  if (raw === null) return { removed };
  const branches = new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(prefixDir, entry.name);
    const isStaging = entry.name.endsWith(".provisioning");
    if (!isStaging) {
      const branch = `${FEATURE_BRANCH_PREFIX}${entry.name}`;
      if (branch === state.baseBranch) continue;
      // `bos/<name>` may be a PARENT segment of a nested branch
      // (`bos/<name>/<more>`), whose clone lives underneath this directory.
      if (branches.has(branch) || [...branches].some((b) => b.startsWith(`${branch}/`))) continue;
    }
    const why = isStaging ? "interrupted clone staging dir" : "no such feature branch";
    try {
      await fs.rm(full, { recursive: true, force: true });
      removed.push(full);
      slog("info", "reconcile", `reclaimed data clone ${full} (${why})`);
    } catch (e) {
      // Reported, never swallowed: a clone that cannot be reclaimed is disk
      // that will not come back on its own, and this is the only thing that
      // would have noticed.
      slog("error", "reconcile", `failed to reclaim data clone ${full} (${why}): ${e?.message || e}`);
    }
  }
  return { removed };
}
