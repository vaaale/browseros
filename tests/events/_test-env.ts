import "../services/_stub-server-only";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
// Relative imports, deliberately NOT the "@/" alias: this worktree's path
// resolves differently through the two specifier styles (alias resolution
// vs. plain relative resolution end up with non-identical resolved paths),
// which made Node load two separate module instances for the same file —
// so a reset here silently missed the singleton state a test file's own
// relative import was mutating. Every test file in tests/events/ must import
// these same modules the same way (relative) for a shared identity.
import { setStoreRoot, shutdownStore } from "../../src/lib/events/store";
import { _resetStreamForTests } from "../../src/lib/events/stream";
import { _resetDispatchForTests } from "../../src/lib/events/dispatch";
import { _resetKernelForTests } from "../../src/lib/events/kernel";

const TMP_ROOT = join(__dirname, ".tmp");
let counter = 0;

/** Creates a fresh, isolated event-store root for one test (R9 — the store
 *  takes an explicit root rather than always resolving dataDir()) and resets
 *  every hot-reload-safe singleton this feature uses, so tests never leak
 *  state into each other regardless of execution order. */
export function useEventTestRoot(label: string): { dir: string; cleanup: () => Promise<void> } {
  const dir = join(TMP_ROOT, `${label}-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  setStoreRoot(dir);
  _resetKernelForTests();
  _resetDispatchForTests();
  _resetStreamForTests();
  return {
    dir,
    cleanup: async () => {
      await shutdownStore().catch(() => {});
      _resetKernelForTests();
      _resetDispatchForTests();
      _resetStreamForTests();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
