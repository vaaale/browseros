import { NextRequest } from "next/server";
import { serviceRegistry } from "@/core/service/ServiceRegistry";

export const dynamic = "force-dynamic";
// Long-lived stream: this route outlives any normal request budget.
export const maxDuration = 3600;

// GET ?since=<seq> — NDJSON: replay ServiceRegistry events after `since`, then
// tail live. Powers real-time Settings UI status updates (FR-033/CH-009) with
// no polling. Mirrors /api/assistant/runs/[runId]/events.
export async function GET(req: NextRequest) {
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0") || 0;

  const encoder = new TextEncoder();
  const KEEPALIVE_MS = 25_000;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = (event: unknown, seq: number, ts: number) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ ...(event as object), seq, ts }) + "\n"));
        } catch {
          closed = true;
          unsubscribe();
        }
      };

      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode('{"type":"ping"}\n'));
        } catch {
          closed = true;
          clearInterval(keepalive);
        }
      }, KEEPALIVE_MS);

      unsubscribe = serviceRegistry().subscribe(since, send);
      req.signal.addEventListener("abort", close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
