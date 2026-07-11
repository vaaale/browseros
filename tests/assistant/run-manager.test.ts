// RunManager invariants (ownership, replay, claims):
//   npx playwright test -c playwright.unit.config.ts

import { test } from "@playwright/test";
import { strict as assert } from "node:assert";

import { RunManager, ActiveRunError } from "../../src/lib/assistant/run-manager";
import type { RunEvent } from "../../src/lib/assistant/run-events";

test.describe("run manager — ownership", () => {
  test("allows exactly one active run per conversation", () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    assert.throws(() => m.create("c1", "a1"), ActiveRunError);
    m.finish(run, "completed");
    assert.ok(m.create("c1", "a1")); // finished run frees the slot
  });

  test("activeFor only reports running runs", () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    assert.equal(m.activeFor("c1")?.id, run.id);
    m.finish(run, "cancelled");
    assert.equal(m.activeFor("c1"), undefined);
  });

  test("finish is terminal and idempotent", () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    m.finish(run, "cancelled");
    m.finish(run, "completed"); // ignored
    assert.equal(run.status, "cancelled");
    assert.equal(run.events.filter((e) => e.type === "run_finished").length, 1);
  });
});

test.describe("run manager — event log & replay", () => {
  test("replays events after `since`, then tails live", () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    m.emit(run, { type: "step_started", step: 0 });
    m.emit(run, { type: "text_delta", messageId: "m1", delta: "a" });

    const seen: RunEvent[] = [];
    const unsubscribe = m.subscribe(run, 1, (e) => seen.push(e));
    assert.deepEqual(seen.map((e) => e.seq), [2]); // replay after seq 1

    m.emit(run, { type: "text_delta", messageId: "m1", delta: "b" });
    assert.deepEqual(seen.map((e) => e.seq), [2, 3]); // live tail
    unsubscribe();
    m.emit(run, { type: "text_delta", messageId: "m1", delta: "c" });
    assert.equal(seen.length, 2);
  });

  test("a finished run still replays its full log to late viewers", () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    m.emit(run, { type: "step_started", step: 0 });
    m.finish(run, "completed");

    const seen: RunEvent[] = [];
    m.subscribe(run, 0, (e) => seen.push(e));
    assert.deepEqual(seen.map((e) => e.type), ["step_started", "run_finished"]);
  });

  test("a throwing viewer never affects the run or other viewers", () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    const seen: RunEvent[] = [];
    m.subscribe(run, 0, () => {
      throw new Error("broken viewer");
    });
    m.subscribe(run, 0, (e) => seen.push(e));
    m.emit(run, { type: "step_started", step: 0 });
    assert.equal(seen.length, 1);
  });
});

test.describe("run manager — frontend tool claims", () => {
  test("first result wins; duplicates are rejected", async () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    const outcome = m.awaitFrontendResult(run, "call-1", 5_000);
    assert.equal(m.submitToolResult(run, "call-1", "from tab A"), true);
    assert.equal(m.submitToolResult(run, "call-1", "from tab B"), false);
    assert.deepEqual(await outcome, { kind: "result", result: "from tab A" });
  });

  test("unknown callId is not claimable", () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    assert.equal(m.submitToolResult(run, "nope", "x"), false);
  });

  test("run abort settles pending dispatches as cancelled", async () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    const outcome = m.awaitFrontendResult(run, "call-1", 5_000);
    m.cancel(run.id);
    assert.deepEqual(await outcome, { kind: "cancelled" });
  });

  test("times out when no client responds", async () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    const outcome = await m.awaitFrontendResult(run, "call-1", 20);
    assert.deepEqual(outcome, { kind: "timeout" });
  });

  test("cancel fires the loop's signal", () => {
    const m = new RunManager();
    const run = m.create("c1", "a1");
    assert.equal(run.abort.signal.aborted, false);
    assert.equal(m.cancel(run.id), true);
    assert.equal(run.abort.signal.aborted, true);
    assert.equal(m.cancel(run.id), true); // idempotent while running
  });
});
