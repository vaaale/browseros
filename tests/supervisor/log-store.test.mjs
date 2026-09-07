// Unit tests for the remaining branches of tools/supervisor/log-store.mjs's
// LogStore not already exercised via control.test.mjs's /logs endpoint
// tests: query() reading across day-timeline files (no session filter), and
// prune()'s actual age-based and size-based removal (both previously only
// exercised with nothing to prune).
//   node --test tests/supervisor/log-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { LogStore } = await import("../../tools/supervisor/log-store.mjs");

test("query: with no session, reads across recent day-timeline files and applies stream/level/since filters", async () => {
  const root = mkdtempSync(join(tmpdir(), "log-store-query-"));
  try {
    const store = new LogStore(root);
    await store._ready;
    await store.write({ level: "info", stream: "backend", component: "c", msg: "old, filtered by since", ts: 1000 });
    await store.write({ level: "debug", stream: "backend", component: "c", msg: "filtered by level", ts: 2000 });
    await store.write({ level: "warn", stream: "frontend", component: "c", msg: "filtered by stream", ts: 3000 });
    await store.write({ level: "error", stream: "backend", component: "c", msg: "matches everything", ts: 4000 });

    const results = await store.query({ stream: "backend", level: "info", since: 1500 });
    assert.deepEqual(results.map((r) => r.msg), ["matches everything"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("query: limit caps the returned records to the most recent N", async () => {
  const root = mkdtempSync(join(tmpdir(), "log-store-limit-"));
  try {
    const store = new LogStore(root);
    await store._ready;
    for (let i = 0; i < 5; i++) await store.write({ level: "info", stream: "backend", component: "c", msg: `m${i}`, ts: i });
    const results = await store.query({ limit: 2 });
    assert.deepEqual(results.map((r) => r.msg), ["m3", "m4"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune: removes files older than retentionDays, but never today's timeline", async () => {
  const root = mkdtempSync(join(tmpdir(), "log-store-prune-age-"));
  try {
    const store = new LogStore(root, { retentionDays: 1 });
    await store._ready;
    await store.write({ level: "info", stream: "backend", component: "c", msg: "today" });
    const todayFiles = readdirSync(store.dir);
    const oldFile = join(store.dir, "timeline-2000-01-01.jsonl");
    writeFileSync(oldFile, JSON.stringify({ ts: 0, level: "info" }) + "\n");
    const longAgo = new Date("2000-01-01").getTime() / 1000;
    utimesSync(oldFile, longAgo, longAgo);

    await store.prune();

    assert.equal(existsSync(oldFile), false, "the old file must be pruned");
    for (const f of todayFiles) assert.equal(existsSync(join(store.dir, f)), true, "today's timeline must survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune: size-based eviction removes the oldest non-active files first until under maxBytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "log-store-prune-size-"));
  try {
    const store = new LogStore(root, { retentionDays: 365, maxBytes: 10 });
    await store._ready;
    const oldButNotAncient = new Date(Date.now() - 20 * 60_000); // 20 min ago — past the 10-min "active" cutoff, within retention
    const olderFile = join(store.buildsDir, "old-build.log");
    const newerFile = join(store.buildsDir, "newer-build.log");
    writeFileSync(olderFile, "x".repeat(20));
    writeFileSync(newerFile, "y".repeat(20));
    const olderTime = new Date(oldButNotAncient.getTime() - 60_000);
    utimesSync(olderFile, olderTime, olderTime);
    utimesSync(newerFile, oldButNotAncient, oldButNotAncient);

    await store.prune();

    assert.equal(existsSync(olderFile), false, "the OLDER file must be evicted first");
    assert.equal(existsSync(newerFile), false, "still over budget after evicting one 20-byte file against a 10-byte cap — the newer one must go too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune: a recently-touched (active) file is never removed even if it would otherwise be evicted", async () => {
  const root = mkdtempSync(join(tmpdir(), "log-store-prune-active-"));
  try {
    const store = new LogStore(root, { retentionDays: 0, maxBytes: 1 });
    await store._ready;
    const activeFile = join(store.buildsDir, "in-progress-build.log");
    writeFileSync(activeFile, "z".repeat(50)); // freshly written -> mtime is "now", within the 10-minute active window
    await store.prune();
    assert.equal(existsSync(activeFile), true, "a file touched within the last 10 minutes must survive both the age and size passes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
