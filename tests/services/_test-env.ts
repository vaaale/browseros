import "./_stub-server-only";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

const TMP_ROOT = join(__dirname, ".tmp");

let counter = 0;

/** Creates a fresh, isolated dataDir() for one test and points BOS_DATA_DIR at
 *  it. Every service module resolves paths through dataDir() at call time, so
 *  this is enough to sandbox all filesystem side effects — no fs mocking.
 *
 *  Also overrides BOS_CANONICAL_DATA to the SAME dir. Every Supervisor-managed
 *  process (base AND every preview worktree — tools/supervisor/lib/base.mjs,
 *  proc.mjs) has BOS_CANONICAL_DATA set in its real environment, deliberately,
 *  so conversations survive a preview's data clone being torn down. os/vfs.ts
 *  routes Documents/Chats through BOS_CANONICAL_DATA specifically, not
 *  BOS_DATA_DIR — leaving it unset here would let any test that touches
 *  conversations escape this sandbox and write into the real canonical data
 *  dir whenever this suite runs inside such a process (e.g. a self-modifying
 *  agent running `npm run test:unit` on its own initiative — this is exactly
 *  how 8 corrupt conversation-file fixtures from this suite ended up in a
 *  real production data dir). */
export function useTestDataDir(label: string): { dir: string; cleanup: () => void } {
  const dir = join(TMP_ROOT, `${label}-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const previousDataDir = process.env.BOS_DATA_DIR;
  const previousCanonicalData = process.env.BOS_CANONICAL_DATA;
  process.env.BOS_DATA_DIR = dir;
  process.env.BOS_CANONICAL_DATA = dir;
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      if (previousDataDir === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previousDataDir;
      if (previousCanonicalData === undefined) delete process.env.BOS_CANONICAL_DATA;
      else process.env.BOS_CANONICAL_DATA = previousCanonicalData;
    },
  };
}

/** Reset the hot-reload-safe globalThis singletons between tests so state
 *  (registered services, worker refs, restart counts, registered service
 *  tools) never leaks across tests that exercise the module-level
 *  serviceRegistry()/serviceManager()/serviceToolBridge(). Safe to reset the
 *  bridge too: any `new ServiceManager()` constructed afterwards re-wires its
 *  dispatcher (039-service-tool-exposure). */
export function resetServiceSingletons(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__bosServiceRegistry;
  delete g.__bosServiceManager;
  delete g.__bosServiceToolBridge;
}
