import "server-only";
import path from "node:path";
import { specsRoot } from "@/os/specs-dir";
import { dataDir } from "@/os/data-dir";
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
//   /Methods/<id>/templates   → ReadonlyFS(<pack>/templates), read-only, one per method
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

/** Mount every registered method's templates at /Methods/<id>/templates.
 *
 *  045 FR-011. Replaces the single /Templates mount, which could only ever
 *  point at one framework's engine — and pointed it at BOS's own source tree,
 *  so an installed pack had nowhere to put its templates.
 *
 *  Idempotent and re-runnable: install and uninstall both call it, which is
 *  why the one-shot `mounted` latch below does NOT guard it. A latched
 *  remount is the bug this shape exists to avoid — mounts would be correct
 *  only for whatever packs happened to be installed at boot. */
export async function remountMethodTemplates(): Promise<void> {
  const { listMethods, methodPackRoot } = await import("@/lib/specs/method/registry");
  const { ensureBuiltinMethod } = await import("@/lib/specs/method/resolve");
  await ensureBuiltinMethod();
  for (const method of listMethods()) {
    // `templates` is PACK-RELATIVE, so it resolves against the root recorded at
    // registration — BOS's tree for the built-in pack, the installed item for
    // any other. 046 removed the builtin/pack branch that used to live here:
    // both are packs now, and only the registrar knows where each came from.
    const root = methodPackRoot(method.id) ?? path.join(dataDir(), "system", method.id);
    // A pack that declares NO templates gets no mount. Mounting anyway pointed
    // /Methods/<id>/templates at the pack root, which is worse than nothing: an
    // agent told to read a template would list the pack's own internals.
    if (!method.templates) continue;
    registerMount(`/Methods/${method.id}/templates`, new ReadonlyFS(path.join(root, method.templates)));
  }
}

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

  // Per-pack template mounts (FR-011).
  await remountMethodTemplates();

  // 046 FR-017 retired the /Templates alias. 045 kept it pointing at
  // `.specify/templates` for one release; 046 DELETED that directory, so the
  // alias now resolves to nothing — keeping it would mean every prompt reading
  // /Templates/commands/<step>.md fails at runtime with an empty read rather
  // than a missing mount, which is the harder failure to attribute. Every
  // reference was rewritten to /Methods/<id>/templates in the same change.
  registerMount("/Docs", new DocsFS());

  logger().debug(COMPONENT, "system VFS mounts registered", {
    userSpecRoot: userSpecRoot(),
    systemSpecRoot: systemSpecRoot(),
  });
}
