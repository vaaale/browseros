import { test, expect } from "@playwright/test";

// Regression test for a real bug: GET /api/assistant/runs/[runId]/events
// crashed with a 500 ("Cannot access 'unsubscribe' before initialization")
// whenever a client attached to (or reconnected to) a run that had ALREADY
// finished by the time the request landed — RunManager.subscribe() replays
// past events SYNCHRONOUSLY before returning, so a replayed `run_finished`
// event's `close()` handler tried to call `unsubscribe` before the `const
// unsubscribe = subscribe(...)` assignment could complete.
//
// User-visible symptom: the client's chat store only ever clears its
// "running" flag (and shows a run's error) by successfully applying a
// `run_finished` event — so a run that already finished before the client's
// GET arrived (the common case for a run that fails/completes FAST) left the
// UI stuck showing "Working…" forever, with no error ever surfacing. This
// test drives the same replay-of-a-finished-run path directly over HTTP,
// browser-less, so it doesn't depend on timing a real UI race.

test.describe("run events endpoint", () => {
  test("replaying an already-finished run's events succeeds and includes run_finished", async ({ request }) => {
    const conversationId = `e2e-run-events-${Date.now()}`;
    const script = JSON.stringify({ turns: [{ text: "hi" }] });

    const startRes = await request.post("/api/assistant/runs", {
      data: { conversationId, agentId: "assistant", message: `@@e2e ${script}` },
      headers: { "content-type": "application/json" },
    });
    expect(startRes.ok()).toBe(true);
    const { runId } = await startRes.json();
    expect(runId).toBeTruthy();

    // Wait for the run to actually finish server-side before we ever ask for
    // its events — this is what puts the events GET on the "replay includes
    // run_finished" path that used to crash.
    await expect
      .poll(async () => {
        const probe = await request.get(`/api/assistant/runs?conversationId=${encodeURIComponent(conversationId)}`);
        const body = await probe.json();
        return body.runId;
      }, { timeout: 10000 })
      .toBeNull();

    const eventsRes = await request.get(`/api/assistant/runs/${encodeURIComponent(runId)}/events?since=0`);
    expect(eventsRes.status()).toBe(200);
    const body = await eventsRes.text();
    const events = body
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "run_finished" && e.reason === "completed")).toBe(true);
  });
});
