import "server-only";
import path from "node:path";
import { specsRoot } from "@/os/specs-dir";
import { registerMount } from "@/os/vfs";
import { SpecFS } from "@/os/fs/spec-fs";
import { ReadonlyFS } from "@/os/fs/readonly-fs";
import { DocsFS } from "@/os/fs/docs-fs";
import { ensureStoresOnce } from "@/lib/specs/seed";
import { logger } from "@/lib/logging/server-logger";

// Wiring for BOS's system VFS mounts (027-vfs-specfs, extended to fold spec_*/
// docs_* tool-layer special-casing into the VFS itself — agents reach all of
// this through the ordinary file_* tools):
//   /Specs/user-specs        → SpecFS, writable, branch-coupled (the same
//                               `bos/*` feature branch used for BOS's own
//                               source — a genuine customization to BOS core
//                               eventually needs code, so its spec rides the
//                               same branch)
//   /Specs/bos-system-specs  → SpecFS, READ-ONLY — the specs BOS ships with;
//                               never editable here, branch or not (a real
//                               customization is written to user-specs
//                               instead). Every write throws
//                               SpecFSReadOnlyError regardless of an active
//                               feature branch.
//   /Templates                → ReadonlyFS(.specify/templates), read-only
//   /Docs                     → DocsFS(docs/), writable, branch-coupled
//
// Idempotent: the first call registers all four mounts and kicks each SpecFS's
// one-time crash-recovery sweep. Invoked lazily from vfs.ensureVfs() via
// dynamic import so the low-level VFS never statically depends on the spec layer.

export const USER_STORE_ID = "user-specs";
export const SYSTEM_STORE_ID = "bos-system-specs";
const COMPONENT = "system-mounts";

export function userSpecRoot(): string {
  return path.join(specsRoot(), USER_STORE_ID);
}
export function systemSpecRoot(): string {
  return path.join(specsRoot(), SYSTEM_STORE_ID);
}

let mounted = false;

export async function ensureSystemMounts(): Promise<void> {
  if (mounted) return;
  mounted = true;

  await ensureStoresOnce().catch((err) =>
    logger().warn(COMPONENT, "spec store seeding failed", { err: String(err) }),
  );

  const worktrees = path.join(specsRoot(), ".worktrees");

  const userSpecFs = new SpecFS(userSpecRoot(), USER_STORE_ID, worktrees, true);
  registerMount("/Specs/user-specs", userSpecFs);
  void userSpecFs.runStartupSweep();

  const systemSpecFs = new SpecFS(systemSpecRoot(), SYSTEM_STORE_ID, worktrees, false);
  registerMount("/Specs/bos-system-specs", systemSpecFs);
  void systemSpecFs.runStartupSweep();

  registerMount("/Templates", new ReadonlyFS(path.join(process.cwd(), ".specify", "templates")));
  registerMount("/Docs", new DocsFS());

  logger().debug(COMPONENT, "system VFS mounts registered", {
    userSpecRoot: userSpecRoot(),
    systemSpecRoot: systemSpecRoot(),
  });
}
