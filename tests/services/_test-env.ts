import "./_stub-server-only";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

const TMP_ROOT = join(__dirname, ".tmp");

let counter = 0;

/** Creates a fresh, isolated dataDir() for one test and points BOS_DATA_DIR at
 *  it. Every service module resolves paths through dataDir() at call time, so
 *  this is enough to sandbox all filesystem side effects — no fs mocking. */
export function useTestDataDir(label: string): { dir: string; cleanup: () => void } {
  const dir = join(TMP_ROOT, `${label}-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const previous = process.env.BOS_DATA_DIR;
  process.env.BOS_DATA_DIR = dir;
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previous;
    },
  };
}

/** Reset the hot-reload-safe globalThis singletons between tests so state
 *  (registered services, worker refs, restart counts) never leaks across
 *  tests that exercise the module-level serviceRegistry()/serviceManager(). */
export function resetServiceSingletons(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__bosServiceRegistry;
  delete g.__bosServiceManager;
}
