import "server-only";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { dataDir } from "@/os/data-dir";
import { gitLogger } from "./logging";

export interface GitMountConfig {
  remoteName: string;
  mountPath: string;
  branch: string;
  status: "synced" | "syncing" | "error";
  lastSynced?: string;
  createdAt: string;
  updatedAt: string;
}

const CONFIG_PATH = join(dataDir(), "config", "git-mounts.json");

function readMounts(): GitMountConfig[] {
  if (!existsSync(CONFIG_PATH)) return [];
  const content = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(content);
}

function writeMounts(mounts: GitMountConfig[]): void {
  const dir = join(dataDir(), "config");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tempPath = `${CONFIG_PATH}.tmp`;
  writeFileSync(tempPath, JSON.stringify(mounts, null, 2));
  renameSync(tempPath, CONFIG_PATH);
  gitLogger().info({ op: "write_mounts" });
}

export function validateMountPath(mountPath: string): boolean {
  const vfsRoot = join(dataDir(), "vfs");
  const resolved = resolve(vfsRoot, mountPath);
  return resolved === vfsRoot || resolved.startsWith(vfsRoot + "/");
}

function remoteHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function ensureBareCacheDir(remoteName: string): string {
  const dir = join(dataDir(), ".git-cache", remoteHash(remoteName));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function mountRepo(
  remoteName: string,
  mountPath: string,
  branch: string = "main",
): GitMountConfig {
  const op = "mount.mountRepo";
  if (!validateMountPath(mountPath)) {
    const msg = `Mount path "${mountPath}" is outside data/vfs/`;
    gitLogger().error({ op, remote: remoteName, error: { code: "MOUNT_PATH_INVALID", message: msg } });
    throw new Error(msg);
  }

  const mounts = readMounts();
  if (mounts.find((m) => m.remoteName === remoteName)) {
    const msg = `Remote "${remoteName}" is already mounted`;
    gitLogger().error({ op, remote: remoteName, error: { code: "ALREADY_MOUNTED", message: msg } });
    throw new Error(msg);
  }

  const now = new Date().toISOString();
  const config: GitMountConfig = {
    remoteName,
    mountPath,
    branch,
    status: "syncing",
    createdAt: now,
    updatedAt: now,
  };

  mounts.push(config);
  writeMounts(mounts);

  ensureBareCacheDir(remoteName);

  gitLogger().info({ op, remote: remoteName });
  return config;
}

export function unmountRepo(remoteName: string): boolean {
  const op = "mount.unmountRepo";
  const mounts = readMounts();
  const index = mounts.findIndex((m) => m.remoteName === remoteName);
  if (index === -1) {
    gitLogger().warn({ op, remote: remoteName, error: { code: "NOT_FOUND", message: `Remote "${remoteName}" is not mounted` } });
    return false;
  }
  mounts.splice(index, 1);
  writeMounts(mounts);
  gitLogger().info({ op, remote: remoteName });
  return true;
}

export function listMounts(): GitMountConfig[] {
  return readMounts();
}

export function getMountStatus(remoteName: string): GitMountConfig | null {
  const mounts = readMounts();
  return mounts.find((m) => m.remoteName === remoteName) ?? null;
}

export function updateMountStatus(
  remoteName: string,
  status: "syncing" | "error" | "synced",
): void {
  const op = "mount.updateMountStatus";
  const mounts = readMounts();
  const mount = mounts.find((m) => m.remoteName === remoteName);
  if (!mount) {
    gitLogger().warn({ op, remote: remoteName, error: { code: "NOT_FOUND", message: `Remote "${remoteName}" is not mounted` } });
    return;
  }
  mount.status = status;
  mount.updatedAt = new Date().toISOString();
  if (status === "synced") mount.lastSynced = new Date().toISOString();
  writeMounts(mounts);
  gitLogger().info({ op, remote: remoteName });
}

// Export helpers for testing.
export {
  readMounts as _readMounts,
  writeMounts as _writeMounts,
  remoteHash as _remoteHash,
};
