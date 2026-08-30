import "server-only";
import type { StreamEvent } from "./types";

// In-memory state-change stream (design.md §3.7) — a bounded ring of recent
// StreamEvents plus a listener set, mirroring ServiceRegistry's subscribe()
// for /api/services/events. Distinct from the per-type `sequence` on events:
// `streamSeq` is a single global counter over state-change notifications.

const MAX_EVENTS = 2000;

interface StampedEvent {
  seq: number;
  ts: number;
  event: Omit<StreamEvent, "streamSeq" | "ts">;
}

interface StreamShape {
  seq: number;
  log: StampedEvent[];
  listeners: Set<(e: StreamEvent) => void>;
}

// globalThis singleton — hot-reload-safe, same pattern as the store/kernel.
const g = globalThis as unknown as { __bosEventStream?: StreamShape };

function state(): StreamShape {
  if (!g.__bosEventStream) g.__bosEventStream = { seq: 0, log: [], listeners: new Set() };
  return g.__bosEventStream;
}

export function publish(event: Omit<StreamEvent, "streamSeq" | "ts">): void {
  const s = state();
  const stamped: StampedEvent = { seq: ++s.seq, ts: Date.now(), event };
  s.log.push(stamped);
  if (s.log.length > MAX_EVENTS) s.log.splice(0, s.log.length - MAX_EVENTS);
  const full: StreamEvent = { ...event, streamSeq: stamped.seq, ts: stamped.ts };
  for (const listener of s.listeners) {
    try {
      listener(full);
    } catch {
      // A broken listener must never affect the stream.
    }
  }
}

/** Replay events with streamSeq > since, then tail live. */
export function subscribe(since: number, onEvent: (e: StreamEvent) => void): () => void {
  const s = state();
  for (const stamped of s.log) {
    if (stamped.seq > since) onEvent({ ...stamped.event, streamSeq: stamped.seq, ts: stamped.ts });
  }
  s.listeners.add(onEvent);
  return () => s.listeners.delete(onEvent);
}

export function currentSeq(): number {
  return state().seq;
}

/** Test-only: forget all buffered events/listeners. */
export function _resetStreamForTests(): void {
  g.__bosEventStream = { seq: 0, log: [], listeners: new Set() };
}
