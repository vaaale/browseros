// Unit tests for the assistant broker's own logic
// (040-assistant-broker-capability, src/components/apps/assistant-broker.ts) —
// the parts that can't be observed from the outside of a browser e2e run:
// per-app run OWNERSHIP (cross-app isolation), replay-from-buffer on attach,
// the authoritative re-fetch when a child's cursor predates the buffer, and
// FR-006 error relay. The full browser path (opaque-origin app → __bos_event →
// frontend tool round-trip) is covered by
// e2e/040-assistant-broker-capability.spec.ts.
//   npm run test:unit -- tests/apps/assistant-broker.test.ts
import { test, expect } from "@playwright/test";
import {
  getBroker,
  releaseBroker,
  retainBroker,
  isAssistantBrokerMethod,
  type BrokerEventEnvelope,
} from "../../src/components/apps/assistant-broker";

// --------------------------------------------------------------- test harness

interface FakeStream {
  push: (event: Record<string, unknown>) => void;
  close: () => void;
}

interface Recorded {
  urls: string[];
  streams: FakeStream[];
}

/**
 * Stub the global fetch with the four run-API endpoints the broker calls. Each
 * events request hands back a live NDJSON stream the test drives by hand, so
 * event delivery can be observed step by step.
 */
function stubFetch(opts?: { startStatus?: number; startBody?: Record<string, unknown> }): {
  rec: Recorded;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const rec: Recorded = { urls: [], streams: [] };
  const encoder = new TextEncoder();

  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    rec.urls.push(url);

    if (url.includes("/events?since=")) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      rec.streams.push({
        push: (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")),
        close: () => controller.close(),
      });
      return { ok: true, status: 200, body: stream };
    }
    if (url.endsWith("/api/assistant/runs") && init?.method === "POST") {
      const status = opts?.startStatus ?? 201;
      return {
        ok: status < 400,
        status,
        json: async () => opts?.startBody ?? { runId: "run-1" },
      };
    }
    if (url.includes("/tool-results")) {
      return { ok: true, status: 200, json: async () => ({ claimed: true }) };
    }
    if (url.includes("/cancel")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, cancelled: true, status: "cancelled" }) };
    }
    if (url.includes("/api/assistant/agent")) {
      return { ok: true, status: 200, json: async () => ({ agents: [{ id: "assistant" }], catalog: {} }) };
    }
    if (url.includes("/api/assistant/runs?conversationId=")) {
      return { ok: true, status: 200, json: async () => ({ runId: null }) };
    }
    throw new Error(`unstubbed fetch: ${url}`);
  }) as unknown as typeof fetch;

  return { rec, restore: () => void (globalThis.fetch = original) };
}

/** Let the reader loop's microtasks/timers run. */
const flush = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

function collector(): { target: { windowId: string; push: (m: BrokerEventEnvelope) => void }; seqs: number[] } {
  const seqs: number[] = [];
  return {
    target: { windowId: "win-1", push: (m) => void seqs.push(m.event.seq) },
    seqs,
  };
}

const event = (seq: number, extra: Record<string, unknown> = {}) => ({
  seq,
  ts: 0,
  runId: "run-1",
  type: "text_delta",
  messageId: "m1",
  delta: `d${seq}`,
  ...extra,
});

// --------------------------------------------------------------------- tests

test("method namespace guard only claims assistant:* methods", () => {
  expect(isAssistantBrokerMethod("assistant:start-run")).toBe(true);
  expect(isAssistantBrokerMethod("fs:read")).toBe(false);
  expect(isAssistantBrokerMethod("storage:get")).toBe(false);
});

test("startRun buffers from seq 0, and a later attach replays the backlog then streams live in order", async () => {
  const { rec, restore } = stubFetch();
  const appId = "t-app-replay";
  const broker = retainBroker(appId);
  const { target, seqs } = collector();
  try {
    const started = (await broker.handle(
      "assistant:start-run",
      { conversationId: "c1", agentId: "assistant", message: "hi" },
      target,
    )) as { runId?: string };
    expect(started.runId).toBe("run-1");
    // The tail opens IMMEDIATELY, before any child has attached — the window
    // between "run started" and "child subscribed" must not lose events.
    await flush();
    expect(rec.urls.some((u) => u.includes("/events?since=0"))).toBe(true);

    // Three events arrive with nobody attached: they go to the buffer only.
    rec.streams[0].push(event(1));
    rec.streams[0].push(event(2));
    rec.streams[0].push(event(3));
    await flush();
    expect(seqs).toEqual([]);

    // Attaching at cursor 0 replays the backlog from memory — no second fetch.
    const ack = (await broker.handle("assistant:events-attach", { runId: "run-1", since: 0 }, target)) as {
      ok?: boolean;
      finished?: boolean;
    };
    expect(ack.ok).toBe(true);
    expect(ack.finished).toBe(false);
    expect(seqs).toEqual([1, 2, 3]);
    expect(rec.streams).toHaveLength(1);

    // …then live events continue, strictly increasing.
    rec.streams[0].push(event(4));
    rec.streams[0].push(event(5, { type: "run_finished", reason: "completed" }));
    await flush();
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  } finally {
    releaseBroker(appId, target.windowId);
    restore();
  }
});

test("a cursor below the buffer's low-water re-opens the server stream at that cursor (reload path)", async () => {
  const { rec, restore } = stubFetch();
  const appId = "t-app-refetch";
  const broker = retainBroker(appId);
  const { target, seqs } = collector();
  try {
    await broker.handle("assistant:start-run", { conversationId: "c1", agentId: "assistant", message: "hi" }, target);
    await flush();
    await broker.handle("assistant:events-attach", { runId: "run-1", since: 0 }, target);

    rec.streams[0].push(event(1));
    rec.streams[0].push(event(2));
    await flush();
    expect(seqs).toEqual([1, 2]);
    // Delivered events are dropped from the cache (NFR-002), so the child's own
    // cursor is now the buffer's floor.

    // The iframe reloads: same window, fresh JS, cursor back to 0 — below
    // low-water, so the parent must go back to the authoritative server log.
    seqs.length = 0;
    await broker.handle("assistant:events-attach", { runId: "run-1", since: 0 }, target);
    await flush();
    expect(rec.streams).toHaveLength(2);
    expect(rec.urls.filter((u) => u.includes("/events?since=0"))).toHaveLength(2);

    // The re-opened stream replays from the server and delivery resumes in order.
    rec.streams[1].push(event(1));
    rec.streams[1].push(event(2));
    rec.streams[1].push(event(3, { type: "run_finished", reason: "completed" }));
    await flush();
    expect(seqs).toEqual([1, 2, 3]);
  } finally {
    releaseBroker(appId, target.windowId);
    restore();
  }
});

test("run ownership is per app: another app's runId is reported as unknown (ADR-3)", async () => {
  const { rec, restore } = stubFetch();
  const ownerId = "t-app-owner";
  const otherId = "t-app-other";
  const owner = retainBroker(ownerId);
  const other = retainBroker(otherId);
  const a = collector();
  const b = collector();
  try {
    await broker(owner, "assistant:start-run", { conversationId: "c1", agentId: "assistant", message: "hi" }, a.target);
    await flush();

    // The other app knows the runId but never started it.
    for (const method of ["assistant:events-attach", "assistant:tool-result", "assistant:cancel-run"]) {
      const res = (await other.handle(
        method,
        { runId: "run-1", callId: "call-1", result: "x" },
        b.target,
      )) as { error?: string; status?: number };
      expect(res.error, method).toBe("unknown run");
      expect(res.status, method).toBe(404);
    }
    // …and it received nothing, while the owner still can drive its own run.
    rec.streams[0].push(event(1, { type: "run_finished", reason: "completed" }));
    await flush();
    expect(b.seqs).toEqual([]);

    const claimed = (await owner.handle(
      "assistant:tool-result",
      { runId: "run-1", callId: "call-1", result: "done" },
      a.target,
    )) as { claimed?: boolean };
    expect(claimed.claimed).toBe(true);
  } finally {
    releaseBroker(ownerId, a.target.windowId);
    releaseBroker(otherId, b.target.windowId);
    restore();
  }
});

test("an API error relays the server's message and status, keeping structured detail (FR-006)", async () => {
  const { restore } = stubFetch({
    startStatus: 409,
    startBody: { error: "conversation already has an active run", activeRunId: "run-9" },
  });
  const appId = "t-app-error";
  const b = retainBroker(appId);
  const { target } = collector();
  try {
    const res = (await b.handle(
      "assistant:start-run",
      { conversationId: "c1", agentId: "assistant", message: "hi" },
      target,
    )) as { error?: string; status?: number; activeRunId?: string; runId?: string };
    expect(res.status).toBe(409);
    expect(res.error).toContain("active run");
    expect(res.activeRunId).toBe("run-9");
    expect(res.runId).toBeUndefined();

    // A failed start grants no ownership, so the 409's runId isn't drivable.
    const attach = (await b.handle("assistant:events-attach", { runId: "run-9", since: 0 }, target)) as {
      error?: string;
    };
    expect(attach.error).toBe("unknown run");
  } finally {
    releaseBroker(appId, target.windowId);
    restore();
  }
});

test("missing required params are rejected before any HTTP call", async () => {
  const { rec, restore } = stubFetch();
  const appId = "t-app-validate";
  const b = retainBroker(appId);
  const { target } = collector();
  try {
    const res = (await b.handle("assistant:start-run", { conversationId: "c1" }, target)) as {
      error?: string;
      status?: number;
    };
    expect(res.status).toBe(400);
    expect(rec.urls).toEqual([]);

    const active = (await b.handle("assistant:active-run", {}, target)) as { error?: string; status?: number };
    expect(active.status).toBe(400);

    await expect(b.handle("assistant:nope", {}, target)).rejects.toThrow(/Unknown method/);
  } finally {
    releaseBroker(appId, target.windowId);
    restore();
  }
});

test("the registry is refcounted: one window closing does not tear down a sibling's tail", async () => {
  const { rec, restore } = stubFetch();
  const appId = "t-app-refcount";
  const first = retainBroker(appId);
  const second = retainBroker(appId);
  expect(second).toBe(first); // same app → same broker
  const seqsA: number[] = [];
  const seqsB: number[] = [];
  const winA = { windowId: "win-a", push: (m: BrokerEventEnvelope) => void seqsA.push(m.event.seq) };
  const winB = { windowId: "win-b", push: (m: BrokerEventEnvelope) => void seqsB.push(m.event.seq) };
  try {
    await first.handle("assistant:start-run", { conversationId: "c1", agentId: "assistant", message: "hi" }, winA);
    await flush();
    await first.handle("assistant:events-attach", { runId: "run-1", since: 0 }, winA);
    await first.handle("assistant:events-attach", { runId: "run-1", since: 0 }, winB);

    rec.streams[0].push(event(1));
    await flush();
    expect(seqsA).toEqual([1]);
    expect(seqsB).toEqual([1]);

    // Window B closes. The app still has a window, so the broker (and the tail)
    // must survive — and B must stop receiving pushes.
    releaseBroker(appId, "win-b");
    rec.streams[0].push(event(2, { type: "run_finished", reason: "completed" }));
    await flush();
    expect(seqsA).toEqual([1, 2]);
    expect(seqsB).toEqual([1]);
    expect(getBroker(appId)).toBe(first);
  } finally {
    releaseBroker(appId, "win-a");
    restore();
  }
});

/** Narrow helper so the isolation test reads as owner-does-X. */
function broker(
  b: ReturnType<typeof getBroker>,
  method: string,
  params: Record<string, unknown>,
  target: { windowId: string; push: (m: BrokerEventEnvelope) => void },
): Promise<unknown> {
  return b.handle(method, params, target);
}
