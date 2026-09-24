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
 *  real production data dir).
 *
 *  And BOS_SPECS_ROOT, for the SAME reason and with a sharper edge:
 *  `specsRoot()` gives that env var precedence over dataDir(), and every
 *  Supervisor-managed process has it set explicitly (tools/supervisor/lib/
 *  base.mjs → the canonical root, proc.mjs → a preview's `<worktree>/specs`).
 *  So overriding BOS_DATA_DIR alone does NOT sandbox the spec stores there:
 *  `run-command.ts` hands the test process `env: process.env`, the var is
 *  inherited, and every `createProject`/`specfs.writeFile` in tests/specs/
 *  lands in the LIVE store — which is how ~50 "Alpha"/"Beta"/"Assistant App"
 *  projects (alpha, alpha-2, … alpha-37: one suffix per leaked run) and an
 *  `alpha/001-foo/renamed.md` accumulated in a real deployment's user-specs
 *  and bos-system-specs, auto-committed by the store's own sweep. */
export function useTestDataDir(label: string): { dir: string; cleanup: () => void } {
  const dir = join(TMP_ROOT, `${label}-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const previousDataDir = process.env.BOS_DATA_DIR;
  const previousCanonicalData = process.env.BOS_CANONICAL_DATA;
  const previousSpecsRoot = process.env.BOS_SPECS_ROOT;
  process.env.BOS_DATA_DIR = dir;
  process.env.BOS_CANONICAL_DATA = dir;
  // Set, not deleted: deleting would fall back to dataDir()/specs, which is
  // the same path — but only while nothing re-reads the ambient value. An
  // explicit override is what actually pins it.
  process.env.BOS_SPECS_ROOT = join(dir, "specs");
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      if (previousDataDir === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previousDataDir;
      if (previousCanonicalData === undefined) delete process.env.BOS_CANONICAL_DATA;
      else process.env.BOS_CANONICAL_DATA = previousCanonicalData;
      if (previousSpecsRoot === undefined) delete process.env.BOS_SPECS_ROOT;
      else process.env.BOS_SPECS_ROOT = previousSpecsRoot;
    },
  };
}

/** Reset the hot-reload-safe globalThis singletons between tests so state
 *  (registered services, worker refs, restart counts, registered service
 *  tools) never leaks across tests that exercise the module-level
 *  serviceRegistry()/serviceManager()/serviceToolBridge(). Safe to reset the
 *  bridge too: any `new ServiceManager()` constructed afterwards re-wires its
 *  dispatcher (039-service-tool-exposure).
 *
 *  The dynamic capability and tool-group layers (041-tool-groups) must go too,
 *  and dropping the bridge is NOT enough to clear them: when a `deploymentMode:
 *  "tools"` worker declares its tools, the bridge writes them into two
 *  SEPARATE process-global registries — `__bos_dynamic_capabilities__`
 *  (src/lib/agent/capabilities-registry.ts) and `__bos_dynamic_tool_groups__`
 *  (src/lib/agent/tool-groups.ts) — which outlive the bridge singleton.
 *
 *  Leaving them behind was a real cross-file failure, not a tidiness point. A
 *  test here whose worker declared tools and then timed out (the crash/restart
 *  lifecycle tests spawn real worker threads and can exceed their wait budget
 *  under load) left capabilities registered whose groups had already been
 *  removed. Playwright reuses a worker process across files, so the next file
 *  to read those registries saw the debris: tests/agent/tool-groups.test.ts's
 *  "every capability's group id resolves to a live group" (the ADR-1/R3
 *  migration invariant) failed intermittently, in a file that had nothing to
 *  do with the test that actually broke. That canary is worth keeping pointed
 *  at real regressions, so the leak is fixed here at its source. */
export function resetServiceSingletons(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__bosServiceRegistry;
  delete g.__bosServiceManager;
  delete g.__bosServiceToolBridge;
  delete g.__bos_dynamic_capabilities__;
  delete g.__bos_dynamic_tool_groups__;
}
