import "server-only";

// In-process rate limiter for the Telegram Bot API. Telegram's 429 responses
// carry a `parameters.retry_after` (seconds) that the caller must respect;
// ignoring it burns the bot's daily quota fast. We track the "not-before" wall
// clock per token — every request checks `waitIfBlocked()` first and callers
// that hit a 429 call `applyRetryAfter(sec)` to push the wall out.
//
// Bot API global limit is 30 msg/sec; we don't implement a proactive rate
// limit here — only the reactive retry_after path. The scheduler-based long
// poller runs at a fixed interval, and message sends are queued behind the
// same limiter, so a bursty client would trip the retry_after path and back
// off automatically.

interface Entry {
  /** Epoch-ms until which this token is blocked. 0 = free. */
  notBefore: number;
}

const state = new Map<string, Entry>();

function get(token: string): Entry {
  let e = state.get(token);
  if (!e) {
    e = { notBefore: 0 };
    state.set(token, e);
  }
  return e;
}

/**
 * Await the next moment the token is allowed to make a request. Returns
 * immediately if not throttled. Uses `setTimeout` — kept simple; the caller
 * is a poller/queue worker so the extra micro-task cost is irrelevant.
 */
export async function waitIfBlocked(token: string): Promise<void> {
  const e = get(token);
  const delta = e.notBefore - Date.now();
  if (delta <= 0) return;
  await new Promise((res) => setTimeout(res, delta));
}

/**
 * Called after receiving a 429 with `retry_after: N`. Extends the block
 * window; multiple concurrent callers all see the SAME notBefore so a burst
 * that hit the limit doesn't chain-multiply the wait.
 */
export function applyRetryAfter(token: string, retryAfterSec: number): void {
  const clamped = Math.max(1, Math.min(3600, Math.floor(retryAfterSec)));
  const e = get(token);
  const proposed = Date.now() + clamped * 1000;
  if (proposed > e.notBefore) e.notBefore = proposed;
}

/** Snapshot: milliseconds until the token is unblocked, or 0 if free. */
export function remainingBlockMs(token: string): number {
  const e = get(token);
  return Math.max(0, e.notBefore - Date.now());
}

/** Test-only: clear all rate-limiter state. */
export function _resetRateLimiter(): void {
  state.clear();
}
