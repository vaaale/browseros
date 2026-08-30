import { NextRequest } from "next/server";
import { subscribe } from "@/lib/events/stream";
import { ensureKernelReady } from "@/lib/events/http";

export const dynamic = "force-dynamic";
// Long-lived stream: this route outlives any normal request budget.
export const maxDuration = 3600;

// GET /api/events/stream?since=<streamSeq> — NDJSON replay-then-tail
// (contract §10, FR-028/NFR-009). Mirrors GET /api/services/events.
export async function GET(req: NextRequest) {
  await ensureKernelReady();
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0") || 0;

  const encoder = new TextEncoder();
  const KEEPALIVE_MS = 15_000;

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

      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
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

      unsubscribe = subscribe(since, send);
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
