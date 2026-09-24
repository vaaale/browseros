// The test sandbox itself, for spec stores.
//
// Regression: `useTestDataDir()` overrode BOS_DATA_DIR (and BOS_CANONICAL_DATA)
// but not BOS_SPECS_ROOT — and `specsRoot()` gives that env var precedence over
// dataDir(). Every Supervisor-managed process sets it explicitly
// (tools/supervisor/lib/base.mjs, proc.mjs) and `run-command.ts` runs the suite
// with `env: process.env`, so inside a real deployment the sandbox silently did
// not cover spec stores: tests/specs/* wrote "Alpha"/"Beta"/"Assistant App"
// projects into the LIVE user-specs and bos-system-specs, once per run, until
// they had accumulated as far as `alpha-37`.
//
// These assertions run with a deliberately hostile ambient environment — they
// fail on the old helper and pass on the new one.
//   npm run test:unit -- tests/specs/test-env-sandbox.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";

/** Stand in for the Supervisor's environment: BOS_SPECS_ROOT pointing at a
 *  "live" store root that no test may ever touch. */
function withAmbientSpecsRoot(body: (live: string) => void): void {
  const live = mkdtempSync(join(tmpdir(), "live-specs-"));
  const previous = process.env.BOS_SPECS_ROOT;
  process.env.BOS_SPECS_ROOT = live;
  try {
    body(live);
  } finally {
    if (previous === undefined) delete process.env.BOS_SPECS_ROOT;
    else process.env.BOS_SPECS_ROOT = previous;
    rmSync(live, { recursive: true, force: true });
  }
}

test("useTestDataDir sandboxes the spec-store root even when the ambient env points elsewhere", () => {
  withAmbientSpecsRoot((live) => {
    expect(specsRoot()).toBe(live); // the hostile precondition really is in effect

    const { dir, cleanup } = useTestDataDir("specs-root-sandbox");
    try {
      // The whole point: inside the sandbox, specsRoot() must resolve under the
      // temp data dir — NOT to whatever the surrounding process was configured
      // with. A store write here can only ever land in the sandbox.
      expect(specsRoot()).toBe(join(dir, "specs"));
      expect(specsRoot().startsWith(dir)).toBe(true);
      expect(specsRoot()).not.toBe(live);
    } finally {
      cleanup();
    }

    // Restored, not clobbered: a suite running inside a real BOS process must
    // leave that process's configuration exactly as it found it.
    expect(specsRoot()).toBe(live);
  });
});

test("useTestDataDir restores an ABSENT BOS_SPECS_ROOT rather than leaving its own value behind", () => {
  const previous = process.env.BOS_SPECS_ROOT;
  delete process.env.BOS_SPECS_ROOT;
  try {
    const { cleanup } = useTestDataDir("specs-root-unset");
    expect(process.env.BOS_SPECS_ROOT).toBeTruthy();
    cleanup();
    // A leftover value would silently redirect every later test in this worker
    // at a directory that has just been deleted.
    expect(process.env.BOS_SPECS_ROOT).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.BOS_SPECS_ROOT;
    else process.env.BOS_SPECS_ROOT = previous;
  }
});

test("cleanup removes the sandboxed store root from disk", async () => {
  const { dir, cleanup } = useTestDataDir("specs-root-cleanup");
  const { ensureStores } = await import("../../src/lib/specs/seed");
  await ensureStores();
  expect(existsSync(join(dir, "specs", "user-specs", "spec-store.json"))).toBe(true);
  cleanup();
  expect(existsSync(dir)).toBe(false);
});
