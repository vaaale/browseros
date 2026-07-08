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

/** Provision a brand-new user: create dirs, clone src, create nm volume, create+start container. */
export async function provisionUser(username: string, cfg: Config): Promise<string> {
  assertValidUsername(username);

  const src = srcDir(username, cfg);
  const data = dataDir(username, cfg);

  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(data, { recursive: true });

  // Clone BOS source for this user from the host repo mounted at bosRepoPath.
  if (!fs.existsSync(path.join(src, ".git"))) {
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
  await execFileAsync("git", ["-C", src, "fetch", "--depth=1", "origin", cfg.bosBaseRef]);
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
