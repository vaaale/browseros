import "../services/_stub-server-only";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";

// Isolated, self-cleaning test root for the self-heal unit tests.
//
// Every module under src/lib/self-heal/** resolves its paths through
// `dataDir()` PER CALL (never captured at module scope), which is what makes
// this work: pointing BOS_DATA_DIR at a temp directory redirects the case
// store, the config namespace and the VFS for the duration of one test, with no
// module-cache games.
//
// BOS_CANONICAL_DATA must be overridden TOO, not just BOS_DATA_DIR. A few VFS
// subtrees are deliberately rooted in CANONICAL data so they survive a
// discarded preview clone (`CANONICAL_SUBPATHS` in src/os/vfs.ts) — and
// `/Documents/Chats` is one of them. Under the Supervisor that variable is set,
// so a test that overrode only BOS_DATA_DIR would silently read and WRITE the
// real conversation store while looking isolated.
//
// Relative imports, deliberately NOT the "@/" alias — the same identity trap
// tests/events/_test-env.ts documents: this worktree resolves the two specifier
// styles to non-identical paths, so a reset here would silently miss the
// singleton state a test file's own relative import mutated. Every file in
// tests/self-heal/ must import src/ modules RELATIVELY.
import { _drainStoreForTests, _resetStoreForTests } from "../../src/lib/self-heal/store";

const TMP_ROOT = join(__dirname, ".tmp");
let counter = 0;

export interface SelfHealTestRoot {
  dir: string;
  /** Write `data/config/selfHeal.json` — the flat storage shape. */
  writeConfig: (values: Record<string, unknown>) => void;
  /** MUST be awaited: it drains in-flight store writes before deleting the
   *  temp root. See the comment on the implementation. */
  cleanup: () => Promise<void>;
}

export function useSelfHealTestRoot(label: string): SelfHealTestRoot {
  const dir = join(TMP_ROOT, `${label}-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  const previousDataDir = process.env.BOS_DATA_DIR;
  const previousCanonical = process.env.BOS_CANONICAL_DATA;
  process.env.BOS_DATA_DIR = dir;
  process.env.BOS_CANONICAL_DATA = dir;
  _resetStoreForTests();

  const writeConfig = (values: Record<string, unknown>) => {
    writeFileSync(join(dir, "config", "selfHeal.json"), JSON.stringify(values, null, 2), "utf8");
  };

  return {
    dir,
    writeConfig,
    cleanup: async () => {
      // The spine deliberately launches the Diagnostician and the BS pipeline
      // without awaiting them (a 034 core executor has to settle its ack fast),
      // so a test can finish with writes still in flight against this temp
      // root. Drain the store's chain, yield once so any queued continuation
      // gets to enqueue its own write, then drain again — otherwise a passing
      // test tears down the directory underneath its own background work and
      // the ENOENT surfaces against whichever test runs next.
      await _drainStoreForTests().catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      await _drainStoreForTests().catch(() => undefined);
      _resetStoreForTests();
      if (previousDataDir === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previousDataDir;
      if (previousCanonical === undefined) delete process.env.BOS_CANONICAL_DATA;
      else process.env.BOS_CANONICAL_DATA = previousCanonical;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A TriggerContext with the fields most tests don't care about filled in. */
export function trigger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trigger: "hard-error",
    toolName: "file_read",
    errorMessage: "permission denied reading /Documents/x.md",
    ...overrides,
  };
}
