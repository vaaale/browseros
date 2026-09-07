// Verifies startPruneInterval's happy path: a properly initialized LogStore
// prunes without incrementing the failure counter.
//   node --test tests/supervisor/log-prune.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { initLogStore, getLogHealth, startPruneInterval } = await import("../../tools/supervisor/lib/log.mjs");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("startPruneInterval: a healthy LogStore prunes cleanly, no failure counted", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "log-prune-test-"));
  try {
    initLogStore(dataDir);
    const before = getLogHealth().pruneFailures;
    const handle = startPruneInterval(3_600_000);
    await nextTick();
    await nextTick();
    assert.equal(getLogHealth().pruneFailures, before);
    clearInterval(handle);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
