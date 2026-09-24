import "server-only";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { dataDir, dataClonesDir } from "@/os/data-dir";

// Filesystem capability probe for the data-isolation layer
// (specs/006-data-isolation/spec.md §4). It detects what the data dir's
// filesystem supports so the isolation-method setting can offer only compatible
// backends and default to the best available. Probe-and-degrade: the universal
// floor (copy, overlay) is always compatible.
//
// The probe runs the operation the clone layer will actually run: FROM a file
// in dataDir() TO a path under dataClonesDir(). Probing inside dataDir() alone
// answers an easier question and gets it wrong wherever the two paths are on
// different mounts — `link(2)` refuses to cross a mount even when the
// superblock is the same, which is exactly the bastion's layout
// (`…/data -> /app/data` and `…/data-clones -> /data-clones` are two binds).
// That mismatch reported the hardlink farm as available, `cp -al` then failed
// with EXDEV on every file, and the Supervisor's fallback silently turned each
// clone into a full copy of the data dir until a production disk filled up.
// See tests/datafs/probe-clone-root.test.ts.

const exec = promisify(execFile);

export type IsolationMethod = "snapshot" | "reflink" | "hardlink" | "copy";

export interface DataFsCapabilities {
  dir: string;
  /** Clone root the capabilities were measured AGAINST (dataClonesDir()). */
  cloneRoot: string;
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

// Errors that mean "this filesystem pair genuinely cannot do that", as opposed
// to "something went wrong while asking". EXDEV is the cross-mount refusal this
// probe exists to catch; EMLINK/EPERM/EACCES/EOPNOTSUPP/ENOSYS are the other
// ways a kernel says no to link(2) or a block clone.
const INCAPABLE = new Set(["EXDEV", "EMLINK", "EPERM", "EACCES", "EOPNOTSUPP", "ENOTSUP", "ENOSYS"]);

function errCode(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  // execFile puts the child's EXIT STATUS in `code` (a number) when the child
  // ran and failed, and an errno STRING only when the spawn itself failed.
  // Only the latter is an errno.
  return typeof code === "string" ? code : undefined;
}

/**
 * Resolve a capability probe's failure. A refusal is an answer ("no"); anything
 * else is a malfunction and must not be laundered into the same "no" — a
 * probe that reports ENOSPC as "hardlinks unsupported" downgrades the whole
 * deployment to full copies on the strength of a transient disk-full, and the
 * result is then CACHED for the life of the process.
 */
function capabilityAnswer(what: string, e: unknown): boolean {
  const code = errCode(e);
  if (code && INCAPABLE.has(code)) return false;
  console.warn(`[datafs] ${what} probe failed for a reason that is not a capability refusal (${code ?? "no errno"}) — reporting unsupported: ${(e as Error)?.message ?? e}`);
  return false;
}

function tmpName(dir: string, suffix: string): string {
  return path.join(dir, `.dfsprobe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

async function discard(...paths: string[]): Promise<void> {
  for (const p of paths) {
    await fs.rm(p, { force: true }).catch((e) => {
      // Not fatal to the probe, but a scratch file the probe cannot remove
      // accumulates in the user's data dir on every reprobe — say so.
      console.warn(`[datafs] could not remove probe scratch file ${p}: ${(e as Error)?.message ?? e}`);
    });
  }
}

/** Can a file in `dir` be hardlinked INTO `cloneRoot`? The clone layer's `cp -al`
 *  does exactly this, once per file. */
async function testHardlink(dir: string, cloneRoot: string): Promise<boolean> {
  const a = tmpName(dir, ".a");
  const b = tmpName(cloneRoot, ".a.lnk");
  try {
    await fs.writeFile(a, "x");
    await fs.link(a, b);
    return true;
  } catch (e) {
    return capabilityAnswer("hardlink", e);
  } finally {
    await discard(a, b);
  }
}

/** Can a file in `dir` be block-cloned INTO `cloneRoot`? */
async function testReflink(dir: string, cloneRoot: string): Promise<boolean> {
  const a = tmpName(dir, ".r");
  const b = tmpName(cloneRoot, ".r.clone");
  try {
    await fs.writeFile(a, "x");
    // GNU coreutils: --reflink=always errors if the FS can't block-clone.
    await exec("cp", ["--reflink=always", a, b], { timeout: 5_000 });
    return true;
  } catch (e) {
    // A non-zero exit from `cp --reflink=always` IS the answer: this pair of
    // paths cannot be block-cloned. Only a spawn failure (no `cp` on PATH —
    // an errno string rather than an exit status) is worth reporting.
    return errCode(e) === undefined ? false : capabilityAnswer("reflink", e);
  } finally {
    await discard(a, b);
  }
}

async function detectFsType(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec("stat", ["-f", "-c", "%T", dir], { timeout: 5_000 });
    return stdout.trim().toLowerCase() || null;
  } catch (e) {
    // Informational only (it feeds the zfs/btrfs hints and the network-FS
    // rename-atomicity guess), so an unreadable type is survivable — but it is
    // never EXPECTED, and silently reporting "unknown filesystem" hides a
    // missing `stat`, a permissions problem, or an unreadable mount.
    console.warn(`[datafs] could not read the filesystem type of ${dir}: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

async function hasBinary(name: string): Promise<boolean> {
  try {
    await exec(name, ["--version"], { timeout: 5_000 });
    return true;
  } catch (e) {
    // ENOENT is the expected absence — the tool simply isn't installed. A
    // non-ENOENT failure means it IS there and misbehaving, which is worth
    // knowing before someone wonders why snapshots were never offered.
    if (errCode(e) !== "ENOENT") {
      console.warn(`[datafs] \`${name} --version\` failed (treating it as unavailable): ${(e as Error)?.message ?? e}`);
    }
    return false;
  }
}

export async function detectDataFsCapabilities(force = false): Promise<DataFsCapabilities> {
  if (cached && !force) return cached;
  const dir = dataDir();
  const cloneRoot = dataClonesDir();
  // Both ends must exist before the pair can be probed. Neither mkdir is
  // optional: if the data dir or the clone root cannot be created, every
  // isolation method is going to fail at use time for the same reason, and a
  // capability report produced by ignoring that is worse than an error.
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(cloneRoot, { recursive: true });

  const [fsType, hardlink, reflink] = await Promise.all([
    detectFsType(dir),
    testHardlink(dir, cloneRoot),
    testReflink(dir, cloneRoot),
  ]);
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

  cached = { dir, cloneRoot, fsType, hardlink, reflink, renameAtomic, zfs, btrfs, methods };
  return cached;
}

/** Best available method for the current filesystem (the recommended default). */
export function bestMethod(caps: DataFsCapabilities): IsolationMethod {
  return caps.methods[0] ?? "copy";
}
