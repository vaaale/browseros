"use client";

// The assistant broker (040-assistant-broker-capability) — the PARENT-FRAME
// side of the `assistant` app capability.
//
// Why this exists: a `marketplace`-origin installed app runs in an iframe
// sandboxed WITHOUT allow-same-origin, so the browser gives it an opaque origin
// and a direct `fetch("/api/assistant/...")` from inside it is cross-origin
// against routes that intentionally set no CORS headers — it fails with a bare
// NetworkError (docs/dev/design-heuristics.md § "Opaque-origin sandboxed apps
// can't fetch() BOS APIs directly"). The fix is never "open CORS": the trusted,
// same-origin parent frame makes the call and relays the result over the
// existing postMessage broker, exactly as fs/settings/services:read do.
//
// The assistant is different from those in ONE way: a run is a *stream*, and an
// NDJSON ReadableStream cannot cross postMessage. So the parent must own the
// stream. It does that by being just another VIEWER of the run's server-side
// event log (`runManager()` in src/lib/assistant/run-manager.ts keeps an
// append-only, monotonically-sequenced `run.events` array — 50k cap, 5 min
// post-finish retention — and `subscribe(run, since, cb)` replays `seq > since`
// then tails live). This module runs the same reader loop the BOS chat's own
// `src/lib/assistant/client/run-client.ts attachToRun` runs, and pushes each
// parsed event into the child iframe as an UNSOLICITED postMessage:
//
//     { __bos_event: true, runId, event }
//
// That push is the only non-request/response broker interaction; the other five
// methods use the normal correlated __bos_call/__bos_response channel.
//
// State model (design.md §3.4/§3.5, ADR-1..ADR-3):
//   - a module-level registry Map<appId, AppBroker>, so broker state survives an
//     iframe reload, an IframeApp effect re-run (e.g. a mid-run capability
//     revoke), and one window of a multi-window app unmounting (refcounted);
//   - one live server tail per RUN, never per poll and never two at once — a
//     second concurrent subscription for the same run would reintroduce exactly
//     the out-of-order hazard the buffer exists to prevent;
//   - a BOUNDED per-run ring buffer (a cache, not a correctness dependency:
//     the server's run.events is always authoritative) so a child that
//     reconnects with a preserved cursor replays with no server round-trip,
//     while a child whose cursor predates the cache (a full iframe reload
//     resets it to 0) triggers a re-fetch at ?since=<cursor>;
//   - RUN OWNERSHIP is per app: only runs THIS app started via `startRun` can be
//     attached to, answered, or cancelled, so guessing another app's runId gets
//     an "unknown run" — cross-app isolation falls out of the registry shape.
//
// See docs/dev/assistant/assistant-broker.md.

import type { RunEvent } from "@/lib/assistant/run-events";
import type { ToolDeclaration } from "@/lib/assistant/tools";
import type { Attachment } from "@/lib/assistant/messages";

/** The unsolicited parent→child message carrying one run event. */
export interface BrokerEventEnvelope {
  __bos_event: true;
  runId: string;
  event: RunEvent;
}

/** How the broker reaches one child iframe. Resolved lazily by the caller so an
 *  iframe reload (same element, new contentWindow) still receives pushes. */
export type BrokerPush = (message: BrokerEventEnvelope) => void;

/** The window a push targets — a window, not an app, is the unit of a child. */
export interface BrokerTarget {
  windowId: string;
  push: BrokerPush;
}

/** Bounded cache (NFR-002). Far below the server's own MAX_EVENTS = 50_000, so
 *  there is always server-side headroom to replay a stale cursor. */
const MAX_BUFFER_EVENTS = 2000;
const MAX_BUFFER_BYTES = 1_000_000;

/** Reconnect backoff for a stream that ended without run_finished, mirroring
 *  run-client.ts: shorter when we did see traffic (likely a proxy hiccup). */
const RETRY_AFTER_EVENTS_MS = 500;
const RETRY_COLD_MS = 2000;

/** Grace before a released broker is torn down, so a window that remounts in
 *  the same tick (React remount, an iframe swap) keeps its live tail. */
const DISPOSE_GRACE_MS = 500;

/** How many runs an app's broker remembers. A window open all day can start
 *  hundreds of runs, and a finished session is still a live map entry (its
 *  buffer is empty, but the ownership record and subscriber map are not), so
 *  the table needs a ceiling. Only FINISHED, UNSUBSCRIBED sessions are evicted,
 *  oldest first — an evicted runId reverts to "unknown run", which is correct:
 *  its events were long since served and the server's own 5-minute retention
 *  has almost certainly expired too. */
const MAX_TRACKED_RUNS = 64;

interface Subscriber {
  push: BrokerPush;
  /** Highest seq pushed to this child. The unit of resumption (FR-003/FR-004). */
  cursor: number;
}

interface RunSession {
  runId: string;
  /** Needed by the reconnect probe (is this still the conversation's live run?). */
  conversationId: string;
  /** Buffered events in ascending seq — a CACHE in front of run.events. */
  events: RunEvent[];
  /** Approximate JSON byte size of `events`, for the byte cap. */
  bytes: number;
  /** Highest seq the tail has appended. */
  highWater: number;
  /** Highest seq NOT retrievable from the buffer. A cursor below this must be
   *  served by re-opening the server stream (the authoritative path). */
  lowWater: number;
  /** run_finished delivered, or the run is gone from the server. */
  finished: boolean;
  /** True once the server reported the run as unknown (retention expiry). */
  expired: boolean;
  /** Attached children, keyed by windowId, each with its own cursor. */
  subscribers: Map<string, Subscriber>;
  /** Single-tail-per-run guard. */
  tailing: boolean;
  abort: AbortController | null;
  /** Bumped to invalidate the in-flight tail loop when restarting at a lower
   *  cursor — the old loop stops appending as soon as it notices. */
  generation: number;
}

/** Every broker reply is a plain object: the API response body on success, and
 *  the API's own `error` + `status` on failure, so an app behaves the same as a
 *  direct fetch would (FR-006). */
type BrokerReply = Record<string, unknown>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const enc = encodeURIComponent;

/** Cheap size estimate for the byte cap. */
function approxSize(event: RunEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 256;
  }
}

/** Relay an API response verbatim (FR-006): the body on success; the body plus
 *  the API's error message and HTTP status on failure. Structured error detail
 *  survives — e.g. the 409 from POST /runs carries `activeRunId`. */
async function relay(res: Response): Promise<BrokerReply> {
  const parsed = (await res.json().catch(() => null)) as unknown;
  const body: BrokerReply =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as BrokerReply) : {};
  if (res.ok) return body;
  return {
    ...body,
    error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
    status: res.status,
  };
}

/** A failed fetch (network, abort) shaped like an API error reply. */
function networkReply(err: unknown): BrokerReply {
  return { error: (err as Error)?.message || "Network error", status: 0 };
}

export class AppBroker {
  /** Number of live app windows referencing this broker (035-style refcount):
   *  a non-singleton app has one IframeApp per window and the registry entry
   *  must outlive all but the last. */
  windowCount = 0;
  /** Pending grace-period teardown, cancelled if a window re-registers. */
  disposeTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly runs = new Map<string, RunSession>();
  /** Runs this app started. The isolation boundary (ADR-3). */
  private readonly owned = new Set<string>();
  private disposed = false;

  constructor(readonly appId: string) {}

  // ---------------------------------------------------------------- dispatch

  /** Route one `assistant:*` broker method. The caller (IframeApp) has already
   *  enforced the `assistant` capability gate. */
  async handle(method: string, params: Record<string, unknown>, target: BrokerTarget): Promise<unknown> {
    switch (method) {
      case "assistant:list-agents":
        return this.listAgents();
      case "assistant:start-run":
        return this.startRun(params);
      case "assistant:events-attach":
        return this.attach(params, target);
      case "assistant:tool-result":
        return this.toolResult(params);
      case "assistant:active-run":
        return this.activeRun(params);
      case "assistant:cancel-run":
        return this.cancelRun(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ----------------------------------------------------------------- methods

  /** GET /api/assistant/agent, relayed whole (ADR-4: strict FR-006 parity, so
   *  the `catalog` rides along even though most apps only read `agents`). */
  private async listAgents(): Promise<BrokerReply> {
    try {
      return await relay(await fetch("/api/assistant/agent"));
    } catch (err) {
      return networkReply(err);
    }
  }

  /**
   * POST /api/assistant/runs. Surface tools ride the start body straight into
   * `startAssistantRun`, which merges them into `run.tools` — identical to the
   * direct-HTTP path, which is what makes FR-009's "exactly as if started via
   * direct HTTP" true rather than approximately true.
   *
   * On success the runId joins the owned set and the tail opens IMMEDIATELY,
   * before the child has attached: events buffer from seq 0, so the window
   * between "run started" and "child subscribed" loses nothing.
   */
  private async startRun(params: Record<string, unknown>): Promise<BrokerReply> {
    const conversationId = String(params.conversationId ?? "").trim();
    const agentId = String(params.agentId ?? "").trim();
    const message = typeof params.message === "string" ? params.message : "";
    const surfaceTools = Array.isArray(params.surfaceTools)
      ? (params.surfaceTools as ToolDeclaration[])
      : undefined;
    const attachments = Array.isArray(params.attachments) ? (params.attachments as Attachment[]) : undefined;
    if (!conversationId || !agentId || (!message.trim() && !attachments?.length)) {
      return { error: "conversationId, agentId and message (or attachments) are required", status: 400 };
    }

    let body: BrokerReply;
    try {
      body = await relay(
        await fetch("/api/assistant/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId,
            agentId,
            message,
            surfaceTools: surfaceTools?.length ? surfaceTools : undefined,
            attachments,
          }),
        }),
      );
    } catch (err) {
      return networkReply(err);
    }

    const runId = typeof body.runId === "string" ? body.runId : undefined;
    if (runId && !this.disposed) {
      this.owned.add(runId);
      const session = this.session(runId, conversationId);
      this.ensureTail(session, session.highWater);
    }
    return body;
  }

  /**
   * Open (or resume) the push stream for a run this app owns — the one method
   * whose payload arrives out-of-band, as `__bos_event` messages.
   *
   * `since` is the child's own last-seen seq. Two reconnect shapes:
   *   - cursor preserved (a dropped listener, a backgrounded tab): the cursor is
   *     at or above the buffer's lowWater, so the gap replays from memory with
   *     no server round-trip;
   *   - cursor reset (a full iframe reload wipes the SDK's lastSeq): the cursor
   *     is below lowWater, so the tail is torn down and re-opened at
   *     ?since=<cursor> and the server — the authoritative log — replays.
   */
  private attach(params: Record<string, unknown>, target: BrokerTarget): BrokerReply {
    const runId = String(params.runId ?? "");
    const session = this.ownedSession(runId);
    if (!session) return unknownRun();
    const since = Math.max(0, Number(params.since ?? 0) || 0);

    // Same windowId re-attaching REPLACES its subscriber (an iframe reload is
    // the same window with fresh JS), which also drops its old high cursor so
    // the buffer floor can fall back to the replay point.
    const sub: Subscriber = { push: target.push, cursor: since };
    session.subscribers.set(target.windowId, sub);

    if (since < session.lowWater) {
      this.restartTail(session, since);
    } else {
      replayTo(session, target.windowId, sub);
      trim(session);
      if (!session.finished) this.ensureTail(session, session.highWater);
    }
    return { ok: true, runId, since, finished: session.finished, expired: session.expired };
  }

  /**
   * POST /api/assistant/runs/[runId]/tool-results — the child executed a
   * frontend tool locally and reports the outcome. First claim wins is the
   * SERVER's semantics (`submitToolResult`); the broker adds no claim logic of
   * its own, which is what preserves FR-010 by construction. A post for a
   * finished/unknown run relays the server's 404 — accepted, ignored.
   */
  private async toolResult(params: Record<string, unknown>): Promise<BrokerReply> {
    const runId = String(params.runId ?? "");
    if (!this.ownedSession(runId)) return unknownRun();
    const callId = String(params.callId ?? "").trim();
    if (!callId) return { error: "callId is required", status: 400 };
    const result = typeof params.result === "string" ? params.result : JSON.stringify(params.result ?? "");
    try {
      return await relay(
        await fetch(`/api/assistant/runs/${enc(runId)}/tool-results`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId, result }),
        }),
      );
    } catch (err) {
      return networkReply(err);
    }
  }

  /** GET /api/assistant/runs?conversationId= — the reconnect probe. NOT
   *  app-scoped: it answers a question about a conversation, exactly as the
   *  direct-HTTP path does (ADR-3 records this as deliberate — an app cannot
   *  guess another app's conversation id, so it is no wider a surface). */
  private async activeRun(params: Record<string, unknown>): Promise<BrokerReply> {
    const conversationId = String(params.conversationId ?? "").trim();
    if (!conversationId) return { error: "conversationId is required", status: 400 };
    try {
      return await relay(await fetch(`/api/assistant/runs?conversationId=${enc(conversationId)}`));
    } catch (err) {
      return networkReply(err);
    }
  }

  /** POST /api/assistant/runs/[runId]/cancel — server-side stop, idempotent. */
  private async cancelRun(params: Record<string, unknown>): Promise<BrokerReply> {
    const runId = String(params.runId ?? "");
    if (!this.ownedSession(runId)) return unknownRun();
    try {
      return await relay(await fetch(`/api/assistant/runs/${enc(runId)}/cancel`, { method: "POST" }));
    } catch (err) {
      return networkReply(err);
    }
  }

  // --------------------------------------------------------------- lifecycle

  /** Drop a closing window's subscriptions. Its cursors were pinning the
   *  buffer floor; without this a closed window's stale cursor would keep
   *  events cached until the hard cap evicted them. */
  detachWindow(windowId: string): void {
    for (const session of this.runs.values()) {
      if (session.subscribers.delete(windowId)) trim(session);
    }
  }

  /** Last window closed: abort every tail and forget every run. */
  dispose(): void {
    this.disposed = true;
    for (const session of this.runs.values()) {
      session.generation += 1;
      session.abort?.abort();
      session.abort = null;
      session.subscribers.clear();
      session.events = [];
    }
    this.runs.clear();
    this.owned.clear();
  }

  // ------------------------------------------------------------------ internals

  private session(runId: string, conversationId: string): RunSession {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    const session: RunSession = {
      runId,
      conversationId,
      events: [],
      bytes: 0,
      highWater: 0,
      lowWater: 0,
      finished: false,
      expired: false,
      subscribers: new Map(),
      tailing: false,
      abort: null,
      generation: 0,
    };
    this.runs.set(runId, session);
    this.evictStaleRuns();
    return session;
  }

  /** Bound the run table (Map preserves insertion order, so this is oldest-first). */
  private evictStaleRuns(): void {
    if (this.runs.size <= MAX_TRACKED_RUNS) return;
    for (const [runId, session] of this.runs) {
      if (this.runs.size <= MAX_TRACKED_RUNS) return;
      if (!session.finished || session.subscribers.size > 0 || session.tailing) continue;
      this.runs.delete(runId);
      this.owned.delete(runId);
    }
  }

  /** A run is reachable only if THIS app started it (ADR-3). A runId belonging
   *  to another app is reported as unknown rather than forbidden, so the reply
   *  leaks nothing about whether it exists. */
  private ownedSession(runId: string): RunSession | undefined {
    if (!runId || !this.owned.has(runId)) return undefined;
    return this.runs.get(runId);
  }

  /** Start the run's single tail if it isn't already running. */
  private ensureTail(session: RunSession, since: number): void {
    if (this.disposed || session.tailing) return;
    session.tailing = true;
    void this.tailLoop(session, session.generation, since);
  }

  /** Re-open the stream at an EARLIER cursor (the authoritative path). The
   *  buffer is reset to that point so replayed events append in seq order and
   *  the single-tail invariant holds: the old loop is invalidated by the
   *  generation bump and stops appending at its next checkpoint. */
  private restartTail(session: RunSession, since: number): void {
    session.generation += 1;
    session.abort?.abort();
    session.abort = null;
    session.tailing = false;
    session.events = [];
    session.bytes = 0;
    session.highWater = since;
    session.lowWater = since;
    session.finished = false;
    session.expired = false;
    this.ensureTail(session, since);
  }

  /**
   * The live tail: the `run-client.ts attachToRun` reader loop, minus the chat
   * store and plus a fan-out to the attached children. Reconnects with
   * ?since=<highWater> while the run is still the conversation's active run.
   */
  private async tailLoop(session: RunSession, gen: number, since: number): Promise<void> {
    let cursor = since;
    try {
      for (;;) {
        if (gen !== session.generation || this.disposed) return;
        const abort = new AbortController();
        session.abort = abort;
        let finished = false;
        let sawEvent = false;
        try {
          const res = await fetch(`/api/assistant/runs/${enc(session.runId)}/events?since=${cursor}`, {
            signal: abort.signal,
          });
          if (gen !== session.generation) return;
          if (res.status === 404) {
            // Evicted from the server's post-finish retention. Nothing more can
            // ever arrive; the app falls back to conversation history, same as
            // any other viewer of an expired run.
            session.finished = true;
            session.expired = true;
            return;
          }
          if (!res.ok || !res.body) throw new Error(`events stream: HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (gen !== session.generation || this.disposed) {
              void reader.cancel().catch(() => undefined);
              return;
            }
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              let event: RunEvent;
              try {
                event = JSON.parse(line) as RunEvent;
              } catch {
                continue;
              }
              // Keepalive lines carry no seq — never buffered, never pushed.
              if ((event as { type: string }).type === "ping") continue;
              sawEvent = true;
              if (typeof event.seq !== "number") continue;
              cursor = Math.max(cursor, event.seq);
              appendAndDeliver(session, event);
              if (event.type === "run_finished") finished = true;
            }
          }
        } catch {
          if (gen !== session.generation || this.disposed) return;
          /* transient drop — retried below */
        }
        if (gen !== session.generation || this.disposed) return;
        if (finished) {
          session.finished = true;
          return;
        }
        // Ended without run_finished: a proxy hiccup or a server restart.
        await sleep(sawEvent ? RETRY_AFTER_EVENTS_MS : RETRY_COLD_MS);
        if (gen !== session.generation || this.disposed) return;
        const probe = (await fetch(`/api/assistant/runs?conversationId=${enc(session.conversationId)}`)
          .then((r) => r.json())
          .catch(() => undefined)) as { runId?: string | null } | undefined;
        if (!probe || probe.runId !== session.runId) {
          // The run is no longer the conversation's live run — nothing to tail.
          session.finished = true;
          return;
        }
      }
    } finally {
      if (gen === session.generation) {
        session.tailing = false;
        session.abort = null;
      }
    }
  }
}

// ------------------------------------------------------------ buffer + fan-out

/** Push one buffered/live event to one child, advancing that child's cursor.
 *  postMessage from a single source to a single iframe is FIFO, so a child sees
 *  strictly increasing seq per run (FR-003). */
function pushOne(session: RunSession, windowId: string, sub: Subscriber, event: RunEvent): void {
  sub.cursor = event.seq;
  try {
    sub.push({ __bos_event: true, runId: session.runId, event });
  } catch {
    // The iframe went away mid-push; stop tracking it (its cursor would
    // otherwise pin the buffer floor forever).
    session.subscribers.delete(windowId);
  }
}

/** Serve the buffered backlog to one freshly-attached child, in seq order. */
function replayTo(session: RunSession, windowId: string, sub: Subscriber): void {
  for (const event of [...session.events]) {
    if (session.subscribers.get(windowId) !== sub) return; // iframe vanished mid-replay
    if (event.seq <= sub.cursor) continue;
    pushOne(session, windowId, sub, event);
  }
}

/** Buffer one live event and fan it out to every child that hasn't seen it. */
function appendAndDeliver(session: RunSession, event: RunEvent): void {
  if (event.seq > session.highWater) {
    session.events.push(event);
    session.bytes += approxSize(event);
    session.highWater = event.seq;
  }
  for (const [windowId, sub] of [...session.subscribers]) {
    if (event.seq <= sub.cursor) continue;
    pushOne(session, windowId, sub, event);
  }
  trim(session);
}

/**
 * Bound the cache (NFR-002). Events at or below every attached child's cursor
 * have been delivered and are dropped; beyond that the hard caps evict the
 * oldest. A cursor that falls below the resulting lowWater is not data loss —
 * it degrades to one re-fetch against the server's authoritative log.
 */
function trim(session: RunSession): void {
  let floor = 0;
  if (session.subscribers.size > 0) {
    floor = Number.POSITIVE_INFINITY;
    for (const sub of session.subscribers.values()) floor = Math.min(floor, sub.cursor);
  }
  while (session.events.length > 0 && session.events[0].seq <= floor) {
    session.bytes -= approxSize(session.events[0]);
    session.events.shift();
  }
  while (
    session.events.length > 0 &&
    (session.events.length > MAX_BUFFER_EVENTS || session.bytes > MAX_BUFFER_BYTES)
  ) {
    session.bytes -= approxSize(session.events[0]);
    session.events.shift();
  }
  if (session.bytes < 0) session.bytes = 0;
  session.lowWater = session.events.length > 0 ? session.events[0].seq - 1 : session.highWater;
}

function unknownRun(): BrokerReply {
  return { error: "unknown run", status: 404 };
}

// -------------------------------------------------------------------- registry

/** Module-level, so broker state outlives an iframe reload, an IframeApp effect
 *  re-run (a mid-run capability revoke must NOT kill an in-flight tail), and
 *  any window of a multi-window app but the last. */
const brokers = new Map<string, AppBroker>();

/** The app's broker, created on demand. Does NOT change the window refcount —
 *  the per-message path calls this, the mount/unmount path uses
 *  retainBroker/releaseBroker. */
export function getBroker(appId: string): AppBroker {
  let broker = brokers.get(appId);
  if (!broker) {
    broker = new AppBroker(appId);
    brokers.set(appId, broker);
  }
  return broker;
}

/** One more app window is live. Cancels a pending teardown. */
export function retainBroker(appId: string): AppBroker {
  const broker = getBroker(appId);
  broker.windowCount += 1;
  if (broker.disposeTimer) {
    clearTimeout(broker.disposeTimer);
    broker.disposeTimer = null;
  }
  return broker;
}

/**
 * One app window closed. Its subscriptions are dropped immediately; the broker
 * itself is torn down only when the LAST window goes, after a short grace period
 * so a window that remounts in the same tick keeps its live tail.
 */
export function releaseBroker(appId: string, windowId: string): void {
  const broker = brokers.get(appId);
  if (!broker) return;
  broker.detachWindow(windowId);
  broker.windowCount = Math.max(0, broker.windowCount - 1);
  if (broker.windowCount > 0 || broker.disposeTimer) return;
  broker.disposeTimer = setTimeout(() => {
    broker.disposeTimer = null;
    if (broker.windowCount > 0) return;
    broker.dispose();
    if (brokers.get(appId) === broker) brokers.delete(appId);
  }, DISPOSE_GRACE_MS);
}

/** True for the broker's own method namespace. */
export function isAssistantBrokerMethod(method: string): boolean {
  return method.startsWith("assistant:");
}
