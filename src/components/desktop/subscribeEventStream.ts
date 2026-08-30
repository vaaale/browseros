import type { StreamEvent } from "@/lib/events/types";

// Shared browser-side NDJSON reader for GET /api/events/stream — used by both
// EventBell and the Event Viewer app so there is exactly one client-side
// parsing implementation (design.md §3.7, FR-028/NFR-009).
export function subscribeEventStream(onMessage: (msg: StreamEvent) => void, since = 0): () => void {
  const controller = new AbortController();
  let cancelled = false;

  void (async () => {
    try {
      const res = await fetch(`/api/events/stream?since=${since}`, { signal: controller.signal });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buf = "";
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as StreamEvent & { type?: string };
            if (parsed.type === "ping") continue; // keepalive
            onMessage(parsed);
          } catch {
            // Ignore a malformed line rather than tearing down the stream.
          }
        }
      }
    } catch {
      // Stream ended/aborted — the caller's effect cleanup handles teardown;
      // callers that want auto-reconnect should re-invoke on their own timer.
    }
  })();

  return () => {
    cancelled = true;
    controller.abort();
  };
}
