import { NextRequest } from "next/server";
import { runManager } from "@/lib/assistant/run-manager";
import type { RunEvent } from "@/lib/assistant/run-events";

export const dynamic = "force-dynamic";
// Streams can outlive any route budget: the run is detached; this is a viewer.
export const maxDuration = 3600;

// GET ?since=<seq> — NDJSON: replay events after `since`, then tail live until
// run_finished. Any number of viewers may attach; closing a viewer never
// affects the run.
export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const run = runManager().get(runId);
  if (!run) {
    return new Response(JSON.stringify({ error: "unknown run" }), { status: 404 });
  }
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0") || 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // subscribe() replays past events SYNCHRONOUSLY before it returns — if the
      // run already finished, that replay includes run_finished, whose `send`
      // calls `close`, which calls `unsubscribe` — all before the `const
      // unsubscribe = subscribe(...)` assignment below could complete. A plain
      // `const` there is a TDZ crash on every attach/reconnect to an
      // already-finished run (i.e. exactly the common case for a run that
      // failed fast). Pre-bind a no-op so `close` always has something to call.
      let unsubscribe: () => void = () => undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (e: RunEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          closed = true;
          unsubscribe();
          return;
        }
        if (e.type === "run_finished") close();
      };
      unsubscribe = runManager().subscribe(run, since, send);
      // A finished run has already replayed everything subscribe() had.
      if (run.status !== "running") close();
      req.signal.addEventListener("abort", close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
