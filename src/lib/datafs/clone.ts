import "server-only";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { detectDataFsCapabilities, type IsolationMethod } from "./probe";

// Clone backends for the data-isolation layer (spec/self-modification/datafs.md
// §3). The Supervisor calls provisionClone() to give a previewed candidate an
// isolated copy of the canonical data dir; discardClone() drops it. The base is
// only ever read here, so the canonical data is never mutated by a preview.

const exec = promisify(execFile);
const CLONE_TIMEOUT_MS = 180_000;

export interface CloneResult {
  /** The backend actually used (may differ from the request after a fallback). */
  method: IsolationMethod;
  target: string;
}

async function copyClone(base: string, target: string): Promise<void> {
  await fs.cp(base, target, { recursive: true });
}

async function reflinkClone(base: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  // --reflink=auto block-clones where supported and falls back to a real copy
  // otherwise; -a preserves attributes.
  await exec("cp", ["-a", "--reflink=auto", base, target], { timeout: CLONE_TIMEOUT_MS });
}

async function hardlinkClone(base: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  // -al = archive + hardlink: a full directory mirror sharing inodes. Correct
  // only because writes are atomic (temp+rename forks a new inode, leaving base
  // untouched) — see writeFileAtomic and datafs.md §6.
  await exec("cp", ["-al", base, target], { timeout: CLONE_TIMEOUT_MS });
}

/**
 * Provision an isolated clone of `base` at `target`. Uses `method` when given
 * and compatible, else the best available; on any backend failure it falls back
 * to a plain recursive copy (the universal floor) so provisioning never fails
 * on a capability mismatch.
 */
export async function provisionClone(base: string, target: string, method?: IsolationMethod): Promise<CloneResult> {
  const caps = await detectDataFsCapabilities();
  const chosen = method && caps.methods.includes(method) ? method : caps.methods[0] ?? "copy";
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  try {
    if (chosen === "reflink") {
      await reflinkClone(base, target);
      return { method: "reflink", target };
    }
    if (chosen === "hardlink") {
      await hardlinkClone(base, target);
      return { method: "hardlink", target };
    }
    await copyClone(base, target);
    return { method: "copy", target };
  } catch (err) {
    if (chosen === "copy") throw err;
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    await copyClone(base, target);
    return { method: "copy", target };
  }
}

/** Remove a clone created by provisionClone (copy/reflink/hardlink → rm -rf). */
export async function discardClone(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}
