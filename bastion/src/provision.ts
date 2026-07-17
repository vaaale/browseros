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

const execFileAsync = promisify(execFile);

const USERNAME_RE = /^[a-z0-9_-]+$/;

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
export async function provisionUser(username: string, cfg: Config): Promise<string> {
  assertValidUsername(username);

  const src = srcDir(username, cfg);
  const data = dataDir(username, cfg);

  fs.mkdirSync(data, { recursive: true });

  // Ensure a valid source checkout. Self-heal from a partial/interrupted prior
  // provision: if src exists but isn't a healthy git repo (e.g. a half-finished
  // clone left a non-empty directory), wipe it so `git clone` gets a clean
  // destination instead of failing with "destination path already exists".
  if (!(await isValidGitRepo(src))) {
    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(src), { recursive: true }); // git clone creates `src` itself
    await execFileAsync("git", ["clone", "--depth=1", "--branch", cfg.bosBaseRef,
      cfg.bosRepoPath, src]);
  }

  await createNmVolume(username);
  const containerId = await createBosContainer(username, cfg);
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
  if (opts.wipeData && fs.existsSync(data)) {
    fs.rmSync(data, { recursive: true, force: true });
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

/** git fetch + switch to bosBaseRef if needed + pull, then restart. */
export async function reprovisionUpdateSrc(username: string, cfg: Config): Promise<void> {
  const src = srcDir(username, cfg);
  // Fetch the target branch explicitly — shallow clones only have the branch
  // they were cloned with, so a generic `fetch origin` won't make other
  // branches available.
  try {
    await execFileAsync("git", ["-C", src, "fetch", "--depth=1", "origin", cfg.bosBaseRef]);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (raw.includes("couldn't find remote ref") || raw.includes("invalid refspec")) {
      throw new Error(
        `Branch '${cfg.bosBaseRef}' not found on the remote. ` +
        `Update BOS_BASE_REF to a valid branch name (e.g. "main").`,
      );
    }
    throw new Error(`git fetch failed: ${raw.split("\n").find((l) => l.trim()) ?? raw}`);
  }
  const { stdout: currentBranch } = await execFileAsync("git", ["-C", src, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch.trim() !== cfg.bosBaseRef) {
    await execFileAsync("git", ["-C", src, "checkout", "-B", cfg.bosBaseRef, "FETCH_HEAD"]);
  } else {
    await execFileAsync("git", ["-C", src, "reset", "--hard", "FETCH_HEAD"]);
  }
  const info = await inspectContainer(containerName(username));
  if (info) {
    if (info.State.Running) await stopContainer(info.Id);
    await startContainer(info.Id);
  } else {
    await _reproStart(username, cfg);
  }
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
