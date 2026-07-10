import { test, expect } from "@playwright/test";
import {
  runToolHandler,
  toolError,
  fetchToolJson,
  readNdjsonStream,
  abortActiveToolRuns,
  hasActiveToolRuns,
  signalUserStop,
  clearUserStop,
} from "../src/lib/agent/tool-kernel";

test.describe("user-stop flag", () => {
  test.afterEach(() => clearUserStop());

  test("a queued handler settles instantly after signalUserStop, without executing", async () => {
    let executed = false;
    signalUserStop("aborted by user");
    const r = await runToolHandler("demo", async () => {
      executed = true;
      return "ran";
    }, { timeoutMs: 1000 });
    expect(r).toBe("Error: demo: aborted by user");
    expect(executed).toBe(false);
  });

  test("signalUserStop settles the running handler AND future ones with the same detail", async () => {
    const running = runToolHandler("demo_run", () => new Promise<string>(() => {}), { timeoutMs: 30_000 });
    await new Promise((res) => setTimeout(res, 20));
    signalUserStop("the conversation was switched");
    expect(await running).toMatch(/^Error: demo_run: the conversation was switched/);
    const queued = await runToolHandler("demo_q", async () => "ran", { timeoutMs: 1000 });
    expect(queued).toMatch(/^Error: demo_q: the conversation was switched/);
  });

  test("clearUserStop restores normal execution", async () => {
    signalUserStop();
    clearUserStop();
    const r = await runToolHandler("demo", async () => "ran", { timeoutMs: 1000 });
    expect(r).toBe("ran");
  });
});

test.describe("tool-run abort registry", () => {
  test("abortActiveToolRuns settles every pending handler with the given detail", async () => {
    const a = runToolHandler("demo_a", () => new Promise<string>(() => {}), { timeoutMs: 30_000 });
    const b = runToolHandler("demo_b", () => new Promise<string>(() => {}), { timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(hasActiveToolRuns()).toBe(true);
    const aborted = abortActiveToolRuns("the conversation was switched");
    expect(aborted).toBe(2);
    expect(await a).toMatch(/^Error: demo_a: the conversation was switched/);
    expect(await b).toMatch(/^Error: demo_b: the conversation was switched/);
    expect(hasActiveToolRuns()).toBe(false);
  });

  test("a settled handler leaves the registry (no abort after completion)", async () => {
    const r = await runToolHandler("demo", async () => "done", { timeoutMs: 1000 });
    expect(r).toBe("done");
    expect(hasActiveToolRuns()).toBe(false);
    expect(abortActiveToolRuns()).toBe(0);
  });
});

// Pure-module spec (no `page` fixture): exercises the tool-execution kernel in
// Node. The kernel contract (assistant-robustness plan, Phase 2): a handler
// never throws and never hangs — it always settles and returns a string; on
// failure the string is a structured, model-readable error.

test.describe("tool kernel", () => {
  test("returns handler result on success", async () => {
    const r = await runToolHandler("demo", async () => "ok", { timeoutMs: 1000 });
    expect(r).toBe("ok");
  });

  test("converts a thrown error into an in-band Error string", async () => {
    const r = await runToolHandler("demo", async () => { throw new Error("boom"); }, { timeoutMs: 1000 });
    expect(r).toMatch(/^Error: demo: boom/);
  });

  test("times out a hung handler and reports it to the agent", async () => {
    const r = await runToolHandler("demo", () => new Promise<string>(() => {}), { timeoutMs: 100 });
    expect(r).toMatch(/^Error: demo: timed out after/);
  });

  test("non-string results are JSON-stringified", async () => {
    const r = await runToolHandler("demo", async () => ({ a: 1 } as unknown as string), { timeoutMs: 1000 });
    expect(r).toBe('{"a":1}');
  });

  test("an external abort (Stop) settles a hung handler as 'aborted by user'", async () => {
    const external = new AbortController();
    setTimeout(() => external.abort(), 50);
    const r = await runToolHandler("demo", () => new Promise<string>(() => {}), {
      timeoutMs: 5000,
      externalSignal: external.signal,
    });
    expect(r).toMatch(/^Error: demo: aborted by user/);
    expect(r).not.toMatch(/timed out/);
  });

  test("the handler's signal fires on timeout so fetches get cancelled", async () => {
    let observed = false;
    await runToolHandler(
      "demo",
      ({ signal }) =>
        new Promise<string>(() => {
          signal.addEventListener("abort", () => { observed = true; });
        }),
      { timeoutMs: 50 },
    );
    expect(observed).toBe(true);
  });

  test("timeout errors include the caller-provided hint", async () => {
    const r = await runToolHandler("demo", () => new Promise<string>(() => {}), {
      timeoutMs: 50,
      timeoutHint: "the thing may still be running",
    });
    expect(r).toMatch(/^Error: demo: timed out after/);
    expect(r).toContain("the thing may still be running");
  });

  test("toolError formats tool, detail and optional hint", () => {
    expect(toolError("demo", "broke")).toBe("Error: demo: broke");
    expect(toolError("demo", "broke", "try again")).toBe("Error: demo: broke — try again");
  });
});

test.describe("fetchToolJson", () => {
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });

  test("returns parsed JSON on success", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const r = await fetchToolJson("demo", "/api/x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.a).toBe(1);
  });

  test("non-OK HTTP becomes an error string with status and body detail", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream exploded spectacularly", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
    const r = await fetchToolJson("demo", "/api/x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/^Error: demo: HTTP 502/);
      expect(r.error).toContain("upstream exploded spectacularly");
    }
  });

  test("long error bodies are truncated to ~200 chars", async () => {
    globalThis.fetch = (async () =>
      new Response("x".repeat(1000), { status: 500 })) as typeof fetch;
    const r = await fetchToolJson("demo", "/api/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeLessThan(300);
  });

  test("invalid JSON becomes an error string, never a throw", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", { status: 200 })) as typeof fetch;
    const r = await fetchToolJson("demo", "/api/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Error: demo: invalid JSON/);
  });

  test("network failure becomes an error string, never a throw", async () => {
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const r = await fetchToolJson("demo", "/api/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Error: demo: fetch failed/);
  });

  test("passes the caller's AbortSignal through to fetch", async () => {
    let seen: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const ctl = new AbortController();
    await fetchToolJson("demo", "/api/x", { signal: ctl.signal });
    expect(seen).toBe(ctl.signal);
  });
});

test.describe("readNdjsonStream", () => {
  test("delivers trimmed non-empty lines and completes on stream end", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"n":1}\n\n  \n{"n":'));
        controller.enqueue(enc.encode('2}\n'));
        controller.close();
      },
    });
    const lines: string[] = [];
    const r = await readNdjsonStream("demo", new Response(stream), (l) => lines.push(l), 1000, "hint");
    expect(r.ok).toBe(true);
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  test("idle timeout aborts a silent stream with a truthful hint", async () => {
    const enc = new TextEncoder();
    // Emits one line, then goes silent forever (never closes).
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"n":1}\n'));
      },
    });
    const lines: string[] = [];
    const r = await readNdjsonStream(
      "demo",
      new Response(stream),
      (l) => lines.push(l),
      100,
      "the stream went silent; check status before retrying",
    );
    expect(lines).toEqual(['{"n":1}']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/^Error: demo: stream idle for /);
      expect(r.error).toContain("the stream went silent; check status before retrying");
    }
  });

  test("a missing body is an error, not a throw", async () => {
    const r = await readNdjsonStream("demo", new Response(null, { status: 200 }), () => {}, 100, "hint");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Error: demo: /);
  });
});
