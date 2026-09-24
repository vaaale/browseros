import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Config } from "./config";
import {
  containerName,
  createBosContainer,
  createNmVolume,
  inspectContainer,
  removeContainer,
  removeNmVolume,
  startContainer,
  stopContainer,
} from "./docker";
import * as logStore from "./log-store";
import { resolveRemoteToken, buildGitCredential, refreshOAuthToken } from "./secrets-reader";

const execFileAsync = promisify(execFile);

const USERNAME_RE = /^[a-z0-9_-]+$/;

/** The git remote name reserved for the bastion's own source — cannot be
 *  edited or deleted by the user and serves as the "factory reset" anchor. */
export const BOS_DEFAULT_REMOTE = "bos-default";

/** chown the src checkout to the container user so npm install can write files. */
async function chownSrc(src: string, cfg: Config): Promise<void> {
  const uid = cfg.containerUid ?? 1000;
  const gid = cfg.containerGid ?? 1000;
  await execFileAsync("chown", ["-R", `${uid}:${gid}`, src]).catch((err) => {
    console.warn(`[bastion] chown ${src} failed (non-fatal):`, err);
  });
}

export function assertValidUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new Error(`Invalid username '${username}': must match [a-z0-9_-]`);
  }
}

function srcDir(username: string, cfg: Config): string {
  return path.join(cfg.volumeBase, username, "src");
}

function dataDir(username: string, cfg: Config): string {
  return path.join(cfg.volumeBase, username, "data");
}

function worktreesDir(username: string, cfg: Config): string {
  return path.join(cfg.volumeBase, username, "worktrees");
}

function dataClonesDir(username: string, cfg: Config): string {
  return path.join(cfg.volumeBase, username, "data-clones");
}

// ── Full provision ─────────────────────────────────────────────────────────────

/** True if `dir` is a healthy git checkout (has a .git and rev-parse succeeds). */
async function isValidGitRepo(dir: string): Promise<boolean> {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  try {
    await execFileAsync("git", ["-C", dir, "rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** Provision a brand-new user: create dirs, clone src, create nm volume, create+start container.
 *  Idempotent and self-healing — safe to re-run after a partial/interrupted attempt. */
export async function provisionUser(
  username: string,
  cfg: Config,
  onProgress?: (msg: string) => void,
): Promise<string> {
  assertValidUsername(username);

  const data = dataDir(username, cfg);
  fs.mkdirSync(data, { recursive: true });

  const src = srcDir(username, cfg);
  // Ensure a valid source checkout. Self-heal from a partial/interrupted prior
  // provision: if src exists but isn't a healthy git repo (e.g. a half-finished
  // clone left a non-empty directory), wipe it so `git clone` gets a clean
  // destination instead of failing with "destination path already exists".
  if (!(await isValidGitRepo(src))) {
    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(src), { recursive: true }); // git clone creates `src` itself
    await execFileAsync("git", ["clone", "--branch", cfg.bosBaseRef,
      cfg.bosRepoPath, src]);
    // Rename the default "origin" remote to the reserved name so users can
    // register their own remotes without losing the bastion's anchor point.
    await execFileAsync("git", ["-C", src, "remote", "rename", "origin", BOS_DEFAULT_REMOTE]).catch(() => {});
    // Re-add any remotes already on record (e.g. a retry after data/ survived
    // a prior partial/interrupted provision attempt).
    await restoreCustomRemotes(src, data, (msg) => logStore.append(username, `[provision] ${msg}`));
    // git runs as root; chown so the BOS container's non-root user can write to
    // the checkout (e.g. npm install writing package-lock.json).
    await chownSrc(src, cfg);
  }

  await createNmVolume(username);
  const containerId = await createBosContainer(username, cfg, onProgress);
  await startContainer(containerId);
  return containerId;
}

// ── Deprovisioning ─────────────────────────────────────────────────────────────

interface DeprovisionOpts {
  wipeSrc: boolean;
  wipeData: boolean;
  wipeNm: boolean;
}

export async function deprovisionUser(username: string, cfg: Config, opts: DeprovisionOpts): Promise<void> {
  assertValidUsername(username);
  const info = await inspectContainer(containerName(username));
  if (info) {
    if (info.State.Running) await stopContainer(info.Id);
    await removeContainer(info.Id);
  }

  const src = srcDir(username, cfg);
  const data = dataDir(username, cfg);

  if (opts.wipeSrc && fs.existsSync(src)) {
    fs.rmSync(src, { recursive: true, force: true });
  }
  // Worktrees are git worktrees of src — wipe them together with src.
  if (opts.wipeSrc && fs.existsSync(worktreesDir(username, cfg))) {
    fs.rmSync(worktreesDir(username, cfg), { recursive: true, force: true });
  }
  if (opts.wipeData && fs.existsSync(data)) {
    fs.rmSync(data, { recursive: true, force: true });
  }
  // Data-clones are snapshots of data — wipe them together with data.
  if (opts.wipeData && fs.existsSync(dataClonesDir(username, cfg))) {
    fs.rmSync(dataClonesDir(username, cfg), { recursive: true, force: true });
  }
  if (opts.wipeNm) {
    await removeNmVolume(username);
  }
}

// ── Re-provision operations (FR-014) ──────────────────────────────────────────

/** Just stop and restart the container. */
export async function reprovisionRestart(username: string, _cfg: Config): Promise<void> {
  const info = await inspectContainer(containerName(username));
  if (!info) throw new Error(`No container for user ${username}`);
  if (info.State.Running) await stopContainer(info.Id);
  await startContainer(info.Id);
}

/** Wipe data/, restart. */
export async function reprovisionResetData(username: string, cfg: Config): Promise<void> {
  await deprovisionUser(username, cfg, { wipeSrc: false, wipeData: true, wipeNm: false });
  fs.mkdirSync(dataDir(username, cfg), { recursive: true });
  await _reproStart(username, cfg);
}

interface UpdateSourceConfig { remote: string; branch?: string; }
interface GitRemoteEntry { name: string; url: string; authType?: string; provider?: string; filesystem?: string; defaultBranch?: string; }

const SOURCE_FS_ID = "bos-src";

/**
 * Resolve which remote/branch "Pull / Update Source" targets.
 *
 * `bos-update-source.json` (an explicit user choice, written by whatever UI
 * eventually exposes one) wins outright when present. Otherwise, prefer a
 * real remote already registered for the `bos-src` filesystem in
 * `git-remotes.json` — the SAME config the in-app "BrowserOS Source" card
 * (Settings → Versions → git remotes) uses — over the `bos-default` factory
 * -reset anchor. Without this, a user who already connected their own
 * GitLab/GitHub remote through the in-app UI still gets silently routed to
 * the (possibly stale) `bos-default` mirror here, and has to configure the
 * same remote a second time in an unrelated Bastion-only preference file
 * that nothing else ever writes. Prefer a remote literally named "origin"
 * if more than one is registered; otherwise take the first.
 */
function readUpdateSourceConfig(data: string, fallbackBranch: string): UpdateSourceConfig {
  try {
    const raw = fs.readFileSync(path.join(data, "bos-update-source.json"), "utf8");
    return JSON.parse(raw) as UpdateSourceConfig;
  } catch {
    const registered = readGitRemotes(data).filter(
      (r) => (r.filesystem ?? SOURCE_FS_ID) === SOURCE_FS_ID && r.name !== BOS_DEFAULT_REMOTE,
    );
    const preferred = registered.find((r) => r.name === "origin") ?? registered[0];
    if (preferred) return { remote: preferred.name, branch: preferred.defaultBranch || fallbackBranch };
    return { remote: BOS_DEFAULT_REMOTE, branch: fallbackBranch };
  }
}

function readGitRemotes(data: string): GitRemoteEntry[] {
  try {
    const raw = fs.readFileSync(path.join(data, "config", "git-remotes.json"), "utf8");
    return JSON.parse(raw) as GitRemoteEntry[];
  } catch {
    return [];
  }
}

function readGitRemoteEntry(data: string, remoteName: string): GitRemoteEntry | null {
  return readGitRemotes(data).find((r) => r.name === remoteName) ?? null;
}

async function listActualGitRemotes(src: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", src, "remote"]);
    return stdout.trim().split("\n").map((r) => r.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Re-add user-registered bos-src remotes into a freshly-cloned checkout.
 *
 * git-remotes.json lives in data/ and survives src/ being wiped and re-cloned
 * (Reset to default, full re-provision), but the actual git remotes live in
 * src/.git/config and do NOT survive a re-clone. Without this, a user's
 * custom remote becomes "orphaned" — still selectable in the source
 * configuration UI, but absent from git, causing fetch to fail with
 * "does not appear to be a git repository".
 */
async function restoreCustomRemotes(src: string, data: string, log: (msg: string) => void): Promise<void> {
  const configured = readGitRemotes(data).filter(
    (r) => (r.filesystem ?? SOURCE_FS_ID) === SOURCE_FS_ID && r.name !== BOS_DEFAULT_REMOTE,
  );
  if (!configured.length) return;
  const existing = new Set(await listActualGitRemotes(src));
  for (const remote of configured) {
    if (existing.has(remote.name)) continue;
    try {
      await execFileAsync("git", ["-C", src, "remote", "add", remote.name, remote.url]);
      log(`Restored remote '${remote.name}' → ${remote.url}`);
    } catch (e) {
      log(`Could not restore remote '${remote.name}' (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * How remote changes are integrated into the user's `src/` checkout.
 *
 * - `reset` — **discards local commits**: hard-reset the target branch onto the
 *   fetched tip. This is the long-standing "Update source" behaviour, and it is
 *   the right one when the checkout should exactly match the remote.
 * - `pull` — **preserves local commits**: fast-forward if possible, otherwise
 *   merge. Refuses rather than clobbering when the tree is dirty or the merge
 *   conflicts. Use this when the user has their own work in `src/` — a promoted
 *   self-modification lands as a commit on the base branch in this very
 *   checkout, and a reset would silently throw it away.
 */
export type UpdateSourceMode = "reset" | "pull";

/**
 * Give the deployment's source checkout real history, once, at bastion startup.
 *
 * Dokploy clones `code/` with `--depth 1 --single-branch` **and deletes and
 * re-clones it on every redeployment**. That breaks the per-user clones which
 * fetch from it (`bos-default` → `/bos-src`): a shallow remote cannot supply the
 * connecting history, so `git fetch` dies with "did not send all necessary
 * objects", and there is no merge base for a pull.
 *
 * Because `code/` is ephemeral by design, a manual `--unshallow` would be undone
 * by the next deploy — so the repair has to run automatically. The bastion starts
 * on every deploy, which makes this the right place for it. Idempotent: once the
 * repo has history the shallow check short-circuits.
 *
 * Never throws. A bastion that cannot reach the git remote must still start.
 */
export async function ensureSourceRepoHasHistory(cfg: Config): Promise<void> {
  const repo = cfg.bosRepoPath;
  const log = (msg: string) => console.log(`[bastion] [source-repo] ${msg}`);

  // `.git` can be a file (worktrees), so ask git rather than stat-ing a path.
  const isRepo = await execFileAsync("git", ["-C", repo, "rev-parse", "--git-dir"]).then(() => true).catch(() => false);
  if (!isRepo) {
    log(`${repo} is not a git repository — skipping (nothing to deepen)`);
    return;
  }
  if (!(await isShallowRepo(repo))) return;

  const remote = await pickRemote(repo);
  if (!remote) {
    log(`${repo} is shallow but has no remote — cannot fetch history. ` +
        `Per-user "Pull / Update Source" will be unavailable.`);
    return;
  }

  log(`${repo} is a shallow clone — fetching full history from "${remote}" so per-user clones can fetch and merge …`);
  try {
    // 10 minutes: a cold unshallow of a large repo over a slow link is still
    // preferable to leaving every source update broken.
    await execFileAsync("git", ["-C", repo, "fetch", "--unshallow", remote], { timeout: 600_000 });
    log("full history restored");
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Already complete (e.g. a previous run, or a non-shallow re-clone) is fine.
    if (/on a complete repository does not make sense/i.test(raw)) {
      log("already has full history");
      return;
    }
    log(`could not deepen ${repo}: ${raw.split("\n")[0]}\n` +
        `  Source updates will fall back to --depth=1, and "Pull / Update Source" will refuse.`);
  }
}

/** The remote to fetch history from — "origin" if present, else the first one. */
async function pickRemote(repo: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "remote"]);
    const remotes = stdout.split("\n").map((r) => r.trim()).filter(Boolean);
    if (remotes.length === 0) return null;
    return remotes.includes("origin") ? "origin" : remotes[0];
  } catch {
    return null;
  }
}

/** Deepen a shallow clone in place. Returns whether it now has history. */
async function tryUnshallow(
  repo: string,
  remote: string,
  branch: string,
  credArgs: string[],
  credEnv: Record<string, string> | undefined,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      [...credArgs, "-C", repo, "fetch", "--unshallow", remote, branch],
      { timeout: 600_000, ...(credEnv ? { env: { ...process.env, ...credEnv } } : {}) },
    );
    return !(await isShallowRepo(repo));
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    log(`Could not deepen this checkout: ${raw.split("\n")[0]}`);
    return !(await isShallowRepo(repo));
  }
}

/** True when a repo is a shallow clone (it has no complete history). */
async function isShallowRepo(repo: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "--is-shallow-repository"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Integrate FETCH_HEAD **without discarding local commits**.
 *
 * Order matters: refuse on a dirty tree BEFORE touching anything, prefer a
 * fast-forward, and if a real merge is needed and it conflicts, `merge --abort`
 * so the checkout is left exactly as it was. The whole point of this mode is
 * that the user's own work survives, so every failure path must be a no-op
 * rather than a partial state.
 */
async function integrateByPull(
  src: string,
  targetBranch: string,
  currentBranch: string,
  log: (msg: string) => void,
): Promise<void> {
  const git = (args: string[]) => execFileAsync("git", ["-C", src, ...args]);

  const { stdout: dirty } = await git(["status", "--porcelain"]);
  // package-lock.json churn from a previous npm install is expected and is not
  // the user's work — the same allowance the Supervisor's promote makes.
  const meaningful = dirty
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.endsWith("package-lock.json"));
  if (meaningful.length > 0) {
    log(`Refusing to pull — uncommitted changes in src/:\n${meaningful.join("\n")}`);
    throw new Error(
      `Cannot pull: ${meaningful.length} uncommitted change(s) in src/. ` +
      `Commit or discard them first, or use "Update source" to overwrite them.\n${meaningful.join("\n")}`,
    );
  }
  if (dirty.trim()) {
    log("Discarding package-lock.json churn from a previous install …");
    await git(["checkout", "--", "package-lock.json"]).catch(() => undefined);
  }

  if (currentBranch !== targetBranch) {
    // Check out the existing local branch if there is one (never -B, which would
    // move it and lose commits); otherwise create it from the fetched tip.
    const exists = await git(["rev-parse", "--verify", `refs/heads/${targetBranch}`]).then(() => true).catch(() => false);
    log(exists ? `Switching to existing ${targetBranch} …` : `Creating ${targetBranch} from the fetched tip …`);
    await git(exists ? ["checkout", targetBranch] : ["checkout", "-b", targetBranch, "FETCH_HEAD"]);
  }

  const ff = await git(["merge", "--ff-only", "FETCH_HEAD"]).then(() => true).catch(() => false);
  if (ff) {
    log("Fast-forwarded to the fetched tip");
    return;
  }

  log("Local commits diverge from the remote — merging …");
  try {
    await git(["-c", "user.email=bos@localhost", "-c", "user.name=BrowserOS", "merge", "--no-edit", "FETCH_HEAD"]);
    log("Merge succeeded — local commits preserved");
  } catch (err) {
    const { stdout: conflicts } = await git(["diff", "--name-only", "--diff-filter=U"]).catch(() => ({ stdout: "" }));
    await git(["merge", "--abort"]).catch(() => undefined);
    const raw = err instanceof Error ? err.message : String(err);
    log(`Merge failed and was aborted — checkout unchanged:\n${raw}`);
    throw new Error(
      `Cannot pull: merging ${targetBranch} would conflict` +
      (conflicts.trim() ? ` in:\n${conflicts.trim()}` : "") +
      `\nThe checkout was left untouched. Resolve it in BrowserOS, or use "Update source" to overwrite local changes.`,
    );
  }
}

/** git fetch + integrate the target branch, then restart.
 *  Respects the user's update-source preference (remote + branch). */
export async function reprovisionUpdateSrc(
  username: string,
  cfg: Config,
  mode: UpdateSourceMode = "reset",
): Promise<void> {
  const src = srcDir(username, cfg);
  const data = dataDir(username, cfg);
  const tag = mode === "pull" ? "pull-and-update-src" : "update-src";
  const log = (msg: string) => logStore.append(username, `[${tag}] ${msg}`);

  // Read user's preferred remote + branch (falls back to bos-default / bosBaseRef).
  const pref = readUpdateSourceConfig(data, cfg.bosBaseRef);
  const targetRemote = pref.remote || BOS_DEFAULT_REMOTE;
  const targetBranch = pref.branch || cfg.bosBaseRef;

  log(`Starting source update (mode: ${mode}, remote: ${targetRemote}, branch: ${targetBranch})`);

  // Migrate legacy "origin" remotes to "bos-default" in existing checkouts.
  try {
    const currentRemotes = await listActualGitRemotes(src);
    if (!currentRemotes.includes(BOS_DEFAULT_REMOTE) && currentRemotes.includes("origin")) {
      log(`Migrating "origin" remote → "${BOS_DEFAULT_REMOTE}" …`);
      await execFileAsync("git", ["-C", src, "remote", "rename", "origin", BOS_DEFAULT_REMOTE]);
      log("Migration done");
    }
  } catch (e) {
    log(`Remote migration warning (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }

  // Self-heal: git-remotes.json (in data/) can drift out of sync with the
  // actual git remotes (in src/.git/config) — e.g. after "Reset to default"
  // or a fresh redeploy wiped src/ while the JSON metadata survived. Re-add
  // the target remote to git if it's configured but missing, instead of
  // letting `git fetch` fail with "does not appear to be a git repository".
  if (targetRemote !== BOS_DEFAULT_REMOTE) {
    const currentRemotes = await listActualGitRemotes(src);
    if (!currentRemotes.includes(targetRemote)) {
      const entry = readGitRemoteEntry(data, targetRemote);
      if (!entry) {
        throw new Error(
          `Remote '${targetRemote}' is selected as the update source but is not registered in git ` +
          `and has no matching entry in your BOS Git Remotes settings. Re-add it there, or switch ` +
          `the source remote in your account settings.`,
        );
      }
      log(`Remote '${targetRemote}' missing from git — re-adding from stored config (${entry.url}) …`);
      await execFileAsync("git", ["-C", src, "remote", "add", targetRemote, entry.url]);
      log("Remote re-added");
    }
  }

  // Resolve credentials for non-default remotes.
  let credArgs: string[] = [];
  let credEnv: Record<string, string> = {};
  if (targetRemote !== BOS_DEFAULT_REMOTE) {
    const entry = readGitRemoteEntry(data, targetRemote);
    if (!entry) {
      throw new Error(`Remote '${targetRemote}' not found in git-remotes.json. Select a different source remote in your account settings.`);
    }
    const authType = entry.authType as "token" | "oauth" | "ssh" | undefined;
    // Log the exact resolution path (authType, provider, store key) — never the
    // secret itself — so a rejected credential is diagnosable from the log
    // instead of guessed at: is this even the credential the user thinks it is?
    const storeKey = authType === "oauth"
      ? `git_remote:oauth:${entry.provider ?? "(no provider set)"}`
      : `git_remote:token:${targetRemote}`;
    log(`Remote '${targetRemote}' auth: authType=${authType ?? "(none)"}, provider=${entry.provider ?? "(none)"}, credential store key='${storeKey}'`);

    if (authType === "ssh") {
      throw new Error(`Remote '${targetRemote}' uses SSH authentication which is not supported for Update Source from the bastion. Use token or OAuth auth.`);
    }
    const tokenResult = resolveRemoteToken(data, targetRemote, authType, entry.provider);
    if (tokenResult) {
      let token = tokenResult.token;
      // Refresh preemptively if expired or expiring within 2 minutes — same
      // buffer as BOS's own resolveAuth() in src/lib/gitops/auth.ts, so this
      // recovers a short-lived GitLab-style token without the user needing to
      // reconnect. No-op (skipped) for tokens with no recorded expiry, e.g. a
      // non-expiring GitHub OAuth App token.
      const expiringSoon = tokenResult.expiresAt !== undefined && tokenResult.expiresAt - Date.now() < 2 * 60_000;
      if (expiringSoon && authType === "oauth" && entry.provider) {
        const minutes = Math.round((Date.now() - (tokenResult.expiresAt ?? 0)) / 60_000);
        log(`Credential at '${storeKey}' is ${minutes > 0 ? `expired ${minutes} min ago` : "about to expire"} — refreshing …`);
        const refreshed = await refreshOAuthToken(data, entry.provider);
        if (refreshed.ok && refreshed.accessToken) {
          log("Refresh succeeded — using the new token");
          token = refreshed.accessToken;
        } else {
          log(`Refresh failed: ${refreshed.error}${refreshed.reconnectRequired ? " — reconnect in Settings → Integrations → Git Providers" : ""}. Falling back to the existing token.`);
        }
      } else {
        const expiryNote = tokenResult.expiresAt ? ` — expires in ${Math.round((tokenResult.expiresAt - Date.now()) / 60_000)} min` : " — no expiry recorded";
        log(`Credential found at '${storeKey}' (${tokenResult.token.length} chars)${expiryNote}`);
      }
      const cred = buildGitCredential(data, token);
      credArgs = cred.args;
      credEnv = cred.env;
    } else {
      log(`No credential found at '${storeKey}' — attempting unauthenticated fetch (will fail if the remote is private)`);
    }
  }

  // Stop the container BEFORE touching the filesystem. The live `next dev`
  // process keeps its watcher open and actively writes HMR/cache files under
  // .next/dev/ — deleting that directory while it's still running races the
  // process's own writes (rmSync lists a dir's contents, then rmdir's it; if
  // Next.js creates a new file in between, rmdir fails with ENOTEMPTY). git
  // fetch/checkout/reset on a live-watched worktree is equally unsafe, so the
  // stop happens before any of that too, not just before the .next/ wipe.
  log("Stopping container before touching the filesystem …");
  const preInfo = await inspectContainer(containerName(username));
  if (preInfo?.State.Running) await stopContainer(preInfo.Id);

  log(`Fetching ${targetRemote}/${targetBranch} …`);

  // A shallow SOURCE cannot satisfy a full-history negotiation: the deployment
  // checkout the user's clone fetches from (`/bos-src`) is a depth-1 clone under
  // Dokploy, and a plain `git fetch` against it dies with
  //   error: Could not read <sha> / fatal: revision walk setup failed
  //   error: /bos-src did not send all necessary objects
  // `--depth=1` asks only for the tip, so there is no walk to fail. We only add
  // it when THIS clone is already shallow — passing it to a full clone would
  // truncate the user's history, which is a different kind of damage.
  let srcShallow = await isShallowRepo(src);
  // Pull needs a merge base, so try to earn one before giving up. This succeeds
  // once the source repo itself has history (see ensureSourceRepoHasHistory).
  if (mode === "pull" && srcShallow) {
    log("Checkout is shallow — fetching full history so a merge base exists …");
    if (await tryUnshallow(src, targetRemote, targetBranch, credArgs, credEnv, log)) {
      srcShallow = false;
      log("History restored — a merge is now possible");
    }
  }

  const fetchArgs = srcShallow
    ? ["fetch", "--depth=1", targetRemote, targetBranch]
    : ["fetch", targetRemote, targetBranch];
  if (srcShallow) log("Shallow checkout — fetching with --depth=1");

  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      [...credArgs, "-C", src, ...fetchArgs],
      credEnv ? { env: { ...process.env, ...credEnv } } : undefined,
    );
    if (String(stdout).trim()) log(`fetch stdout: ${String(stdout).trim()}`);
    if (String(stderr).trim()) log(`fetch stderr: ${String(stderr).trim()}`);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    log(`Fetch failed:\n${raw}`);
    if (raw.includes("couldn't find remote ref") || raw.includes("invalid refspec")) {
      throw new Error(`Branch '${targetBranch}' not found on remote '${targetRemote}'.`);
    }
    if (raw.includes("did not send all necessary objects") || raw.includes("revision walk setup failed")) {
      throw new Error(
        `git fetch failed because '${targetRemote}' is a shallow clone and cannot supply the connecting history.\n` +
        `Make the deployment's source checkout a full clone (or unshallow it) and retry.\n${raw}`,
      );
    }
    throw new Error(`git fetch failed:\n${raw}`);
  }
  log("Fetch succeeded");

  const { stdout: currentBranch } = await execFileAsync("git", ["-C", src, "rev-parse", "--abbrev-ref", "HEAD"]);
  log(`Current branch: ${currentBranch.trim()}`);

  if (mode === "pull") {
    // Merging needs a merge base, which a shallow clone does not have. Say so
    // plainly instead of letting git fail with "refusing to merge unrelated
    // histories" or a truncated-history merge that silently loses commits.
    if (srcShallow) {
      log("Refusing to pull — this checkout is a shallow clone, so there is no merge base");
      throw new Error(
        `Cannot pull: this instance's src/ has no history and could not be deepened, so there is no merge base.\n` +
        `That happens when '${targetRemote}' is itself a shallow clone. Use "Update source" to take the remote's ` +
        `state as-is, or give the deployment's source checkout full history and retry.`,
      );
    }
    await integrateByPull(src, targetBranch, currentBranch.trim(), log);
  } else if (currentBranch.trim() !== targetBranch) {
    log(`Switching to ${targetBranch} (discarding any local state on it) …`);
    await execFileAsync("git", ["-C", src, "checkout", "-B", targetBranch, "FETCH_HEAD"]);
  } else {
    log("Already on target branch — resetting to FETCH_HEAD (local commits discarded) …");
    await execFileAsync("git", ["-C", src, "reset", "--hard", "FETCH_HEAD"]);
  }
  log("Integration done");

  // Wipe the Next.js compilation cache. git reset --hard preserves gitignored
  // directories like .next/, and a stale Turbopack cache from the previous
  // installation can cause certain API routes to fail after an update.
  const nextCacheDir = path.join(src, ".next");
  if (fs.existsSync(nextCacheDir)) {
    log("Clearing .next/ cache …");
    fs.rmSync(nextCacheDir, { recursive: true, force: true });
    log(".next/ cleared");
  }

  // git reset --hard recreates files as root; chown so npm install can write them.
  log("Fixing file ownership …");
  await chownSrc(src, cfg);
  log("Ownership fixed");

  log("Starting container …");
  if (preInfo) {
    await startContainer(preInfo.Id);
  } else {
    await _reproStart(username, cfg);
  }
  log("Container started — update complete");
}

/** Wipe src/ + worktrees, re-clone from bos-default, restart. Data is preserved. */
export async function reprovisionResetToDefault(username: string, cfg: Config): Promise<void> {
  const log = (msg: string) => logStore.append(username, `[reset-to-default] ${msg}`);
  log(`Resetting source to ${cfg.bosBaseRef} from ${cfg.bosRepoPath} …`);

  // Stop container before touching the filesystem.
  const info = await inspectContainer(containerName(username));
  if (info?.State.Running) await stopContainer(info.Id);

  // Wipe the source checkout and any branch worktrees (data/ is untouched).
  const src = srcDir(username, cfg);
  const worktrees = worktreesDir(username, cfg);
  log("Wiping src/ and worktrees/ …");
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(worktrees, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(src), { recursive: true });

  // Fresh shallow clone from the bastion's source.
  log(`Cloning ${cfg.bosRepoPath} @ ${cfg.bosBaseRef} …`);
  await execFileAsync("git", ["clone", "--branch", cfg.bosBaseRef, cfg.bosRepoPath, src]);

  // Rename "origin" to the reserved name for consistency.
  await execFileAsync("git", ["-C", src, "remote", "rename", "origin", BOS_DEFAULT_REMOTE]).catch(() => {});
  log(`Clone done — remote set to "${BOS_DEFAULT_REMOTE}"`);

  // Re-add any user-registered remotes lost in the wipe (git-remotes.json
  // metadata lives in data/ and survives; the actual git remotes did not).
  const data = dataDir(username, cfg);
  await restoreCustomRemotes(src, data, log);

  await chownSrc(src, cfg);
  log("Ownership fixed");

  // Restart (or create) the container.
  if (info) {
    await startContainer(info.Id);
  } else {
    await _reproStart(username, cfg);
  }
  log("Container restarted — reset complete");
}

/** Wipe node_modules volume, restart (npm install happens on container start). */
export async function reprovisionRebuildNm(username: string, cfg: Config): Promise<void> {
  const info = await inspectContainer(containerName(username));
  if (info?.State.Running) await stopContainer(info.Id);
  await removeNmVolume(username);
  await createNmVolume(username);
  if (info) {
    // Recreate container so it picks up the new empty volume
    await removeContainer(info.Id);
  }
  const containerId = await createBosContainer(username, cfg);
  await startContainer(containerId);
}

/** Full deprovision + full reprovision. */
export async function reprovisionFull(username: string, cfg: Config): Promise<void> {
  await deprovisionUser(username, cfg, { wipeSrc: true, wipeData: true, wipeNm: true });
  await provisionUser(username, cfg);
}

async function _reproStart(username: string, cfg: Config): Promise<void> {
  const info = await inspectContainer(containerName(username));
  if (info) {
    await startContainer(info.Id);
  } else {
    const id = await createBosContainer(username, cfg);
    await startContainer(id);
  }
}
