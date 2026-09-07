// Unit tests for tools/supervisor/lib/log.mjs's failure-counting paths.
// log()/slog()/startPruneInterval's pruneOnce must never crash the caller
// even if initLogStore() was never called (logStore stays null) — every
// failure is instead counted via getLogHealth() so a persistently-broken
// sink is visible on /__supervisor/health instead of silently swallowed.
// Deliberately does NOT call initLogStore — own process (module-level
// `logStore` variable persists for the life of this file/process).
//   node --test tests/supervisor/log-uninitialized.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { log, slog, getLogHealth, startPruneInterval } = await import("../../tools/supervisor/lib/log.mjs");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("log()/slog() count a dropped write instead of throwing when no LogStore is initialized", () => {
  const before = getLogHealth().droppedLogWrites;
  assert.doesNotThrow(() => log("hello"));
  assert.doesNotThrow(() => slog("info", "test", "hello"));
  const after = getLogHealth();
  assert.equal(after.droppedLogWrites, before + 2);
});

test("startPruneInterval's immediate pruneOnce counts a failure instead of throwing when no LogStore is initialized", async () => {
  const before = getLogHealth().pruneFailures;
  const handle = startPruneInterval(3_600_000); // long interval — only the immediate call fires during this test
  await nextTick();
  await nextTick();
  assert.equal(getLogHealth().pruneFailures, before + 1);
  clearInterval(handle);
});
