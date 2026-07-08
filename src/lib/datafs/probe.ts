import "server-only";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { dataDir } from "@/os/data-dir";

// Filesystem capability probe for the data-isolation layer
// (specs/006-data-isolation/spec.md §4). It detects what the data dir's
// filesystem supports so the isolation-method setting can offer only compatible
// backends and default to the best available. Probe-and-degrade: the universal
// floor (copy, overlay) is always compatible.

const exec = promisify(execFile);

export type IsolationMethod = "snapshot" | "reflink" | "hardlink" | "copy";

export interface DataFsCapabilities {
  dir: string;
  /** Filesystem type name (Linux `stat -f`), e.g. "zfs", "btrfs", "ext2/ext3", "xfs", "cifs". */
  fsType: string | null;
  hardlink: boolean;
  reflink: boolean;
  /** Whether rename-over-existing is assumed atomic (false on known network FSes). */
  renameAtomic: boolean;
  /** On ZFS with the `zfs` tool present (native snapshot possible, privileges checked at use). */
  zfs: boolean;
  /** On btrfs with the `btrfs` tool present. */
  btrfs: boolean;
  /** Compatible isolation methods, best-first. */
  methods: IsolationMethod[];
}

// Filesystem capability is stable for a process; probe once.
let cached: DataFsCapabilities | null = null;

const NETWORK_FS = new Set(["cifs", "smb", "smb2", "smb3", "nfs", "nfs4", "fuseblk", "fuse", "9p"]);

async function tmpName(dir: string, suffix: string): Promise<string> {
  return path.join(dir, `.dfsprobe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

async function testHardlink(dir: string): Promise<boolean> {
  const a = await tmpName(dir, ".a");
  const b = `${a}.lnk`;
  try {
    await fs.writeFile(a, "x");
    await fs.link(a, b);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(a, { force: true }).catch(() => {});
    await fs.rm(b, { force: true }).catch(() => {});
  }
}

async function testReflink(dir: string): Promise<boolean> {
  const a = await tmpName(dir, ".r");
  const b = `${a}.clone`;
  try {
    await fs.writeFile(a, "x");
    // GNU coreutils: --reflink=always errors if the FS can't block-clone.
    await exec("cp", ["--reflink=always", a, b], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(a, { force: true }).catch(() => {});
    await fs.rm(b, { force: true }).catch(() => {});
  }
}

async function detectFsType(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec("stat", ["-f", "-c", "%T", dir], { timeout: 5_000 });
    return stdout.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

async function hasBinary(name: string): Promise<boolean> {
  try {
    await exec(name, ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectDataFsCapabilities(force = false): Promise<DataFsCapabilities> {
  if (cached && !force) return cached;
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => {});

  const [fsType, hardlink, reflink] = await Promise.all([detectFsType(dir), testHardlink(dir), testReflink(dir)]);
  const renameAtomic = !(fsType && NETWORK_FS.has(fsType));
  const zfs = fsType === "zfs" && (await hasBinary("zfs"));
  const btrfs = fsType === "btrfs" && (await hasBinary("btrfs"));

  // Offered backends (best-first). Native CoW snapshot (zfs/btrfs) needs the
  // data dir to be a dedicated dataset/subvolume + privileges, and the sparse
  // app-level overlay needs a read-through resolver — both are recognized here
  // (see the zfs/btrfs flags) but not yet provisioned by the clone layer
  // (lib/datafs/clone.ts), so they are not offered as selectable methods yet.
  const methods: IsolationMethod[] = [];
  if (reflink) methods.push("reflink");
  if (hardlink) methods.push("hardlink");
  methods.push("copy"); // universal floor — always works

  cached = { dir, fsType, hardlink, reflink, renameAtomic, zfs, btrfs, methods };
  return cached;
}

/** Best available method for the current filesystem (the recommended default). */
export function bestMethod(caps: DataFsCapabilities): IsolationMethod {
  return caps.methods[0] ?? "copy";
}
