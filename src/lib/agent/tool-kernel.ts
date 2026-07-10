// Framework-free tool-execution kernel (client-side). No "use client" needed:
// pure functions + fetch; imported by the *Actions.tsx components.
//
// Contract (assistant-robustness plan, Phase 2 — non-negotiable): a client
// tool handler never throws and never hangs. CopilotKit executes a message's
// tool calls sequentially (await per call), so one hung handler stalls the
// whole run forever. Every handler therefore runs inside runToolHandler(),
// which guarantees it settles and returns a string; on failure the string is
// a structured, model-readable error (`Error: <tool>: <what failed> — <hint>`)
// so the agent is notified in-band and can react. Timeouts use the configured
// Settings → Tools value: total duration for request/response tools, idle
// (silence) duration for streaming tools (readNdjsonStream).

const TIMEOUT_DEFAULT_MS = 600_000;
const TIMEOUT_REFRESH_MS = 30_000;
const TIMEOUT_MIN_SEC = 10;
const TIMEOUT_MAX_SEC = 3600;

let cachedTimeoutMs = TIMEOUT_DEFAULT_MS;
let cachedAt = 0;
let refreshInFlight: Promise<void> | null = null;

async function refreshTimeout(): Promise<void> {
  try {
    // GET /api/config returns every namespace: { schemas: [{ namespace,
    // ...schema, values, secretsSet }] } — there is no ?namespace= filter
    // (see src/app/api/config/route.ts), so pick the "tools" entry out.
    const r = await fetch("/api/config");
    const j = (await r.json()) as {
      schemas?: { namespace: string; values?: Record<string, unknown> }[];
    };
    const tools = (j.schemas ?? []).find((s) => s.namespace === "tools");
    const sec = tools?.values?.toolCallTimeoutSec;
    if (typeof sec === "number" && Number.isFinite(sec)) {
      cachedTimeoutMs = Math.min(TIMEOUT_MAX_SEC, Math.max(TIMEOUT_MIN_SEC, Math.round(sec))) * 1000;
    }
  } catch {
    /* keep previous value */
  }
  cachedAt = Date.now();
}

/** The configured tool-call timeout (Settings → Tools) in milliseconds.
 *  Synchronous: returns the cached value immediately and refreshes it in the
 *  background when stale (>30 s) or after a settings-change event, so a call
 *  right after a settings edit may still see the previous value once. */
export function getToolTimeoutMs(): number {
  if (Date.now() - cachedAt > TIMEOUT_REFRESH_MS && !refreshInFlight) {
    refreshInFlight = refreshTimeout().finally(() => {
      refreshInFlight = null;
    });
  }
  return cachedTimeoutMs;
}

if (typeof window !== "undefined") {
  // Invalidate the cache on the events that actually fire when relevant
  // settings change: ToolsTab dispatches "bos:tools-config-updated" after
  // persisting a tools-namespace value; agent settings (DefaultAgentTab,
  // AgentDetails) dispatch "bos:agent-updated". The 30 s staleness window
  // covers changes made through other paths (e.g. the config_set tool).
  const invalidate = () => {
    cachedAt = 0;
  };
  window.addEventListener("bos:tools-config-updated", invalidate);
  window.addEventListener("bos:agent-updated", invalidate);
}

/** Formats the in-band, model-readable error string every failed tool call returns. */
export function toolError(tool: string, detail: string, hint?: string): string {
  return `Error: ${tool}: ${detail}${hint ? ` — ${hint}` : ""}`;
}

// Registry of in-flight tool runs. CopilotKit awaits client tool handlers with
// no cancellation of its own, so Stop and conversation switches must be able to
// settle them from the outside: each runToolHandler enrolls here for its
// lifetime, and abortActiveToolRuns() settles every pending handler with an
// in-band error the model can react to.
const activeRuns = new Set<(detail: string) => void>();

/** Abort every in-flight tool handler (Stop button, conversation switch).
 *  Each settles immediately with `Error: <tool>: <detail>`. Returns how many
 *  runs were aborted. */
export function abortActiveToolRuns(detail = "aborted by user"): number {
  const aborted = activeRuns.size;
  for (const abort of [...activeRuns]) abort(detail);
  return aborted;
}

/** True while any tool handler is executing (drives Stop-button visibility). */
export function hasActiveToolRuns(): boolean {
  return activeRuns.size > 0;
}

const activeRunListeners = new Set<() => void>();

/** Subscribe to active-run count changes (for useSyncExternalStore). */
export function subscribeActiveToolRuns(cb: () => void): () => void {
  activeRunListeners.add(cb);
  return () => activeRunListeners.delete(cb);
}

function notifyActiveRuns(): void {
  for (const l of activeRunListeners) l();
}

// User-stop flag. CopilotKit executes a turn's tool calls SEQUENTIALLY and its
// React wrapper drops the per-handler abort signal (react-core, verified in
// 1.61.2 and 1.62.3), so aborting the RUNNING handler is not enough: the
// QUEUED handlers of the same turn would still execute afterwards ("the agent
// continues in the background"). While this flag is set, runToolHandler
// settles every newly-starting handler immediately with the stop detail —
// the check CopilotKit's own machinery would have done had the signal reached
// the handler. Cleared when a new run initializes (an explicit command:
// send/regenerate) — see RunStopGuard in CopilotProvider.tsx.
let stopRequested: string | null = null;

/** User-initiated stop (Stop button, conversation switch): aborts every
 *  in-flight handler AND flags queued/future handlers to settle immediately
 *  until the next commanded run. Returns how many in-flight runs were aborted. */
export function signalUserStop(detail = "aborted by user"): number {
  stopRequested = detail;
  return abortActiveToolRuns(detail);
}

/** Clears the user-stop flag (a new commanded run is starting). */
export function clearUserStop(): void {
  stopRequested = null;
}

export interface RunToolOpts {
  /** Override; defaults to the configured Settings → Tools value. */
  timeoutMs?: number;
  /** Extra hint appended to timeout errors (e.g. "the sub-agent may still be running"). */
  timeoutHint?: string;
  /** Externally supplied abort (e.g. CopilotKit's Stop button). Firing it
   *  settles the handler with `Error: <tool>: aborted by user` instead of a
   *  timeout message. */
  externalSignal?: AbortSignal;
}

/** Runs a tool handler with the guaranteed-settle contract: resolves with the
 *  handler's result (non-strings JSON-stringified) or an in-band `Error: …`
 *  string on throw/timeout/abort. Never rejects. The handler receives a
 *  `signal` that fires on timeout OR external abort — pass it to every fetch
 *  so aborted work is actually cancelled, not just abandoned. */
export async function runToolHandler(
  tool: string,
  fn: (ctx: { signal: AbortSignal }) => Promise<unknown>,
  opts: RunToolOpts = {},
): Promise<string> {
  // A user stop covers the WHOLE turn: queued handlers settle before starting.
  if (stopRequested) return toolError(tool, stopRequested);
  const timeoutMs = opts.timeoutMs ?? getToolTimeoutMs();
  const ctl = new AbortController();
  // Why the abort happened, recorded BEFORE ctl.abort() so the race rejection
  // below always sees the right message.
  let abortDetail = "";
  const timer = setTimeout(() => {
    abortDetail = `timed out after ${Math.round(timeoutMs / 1000)}s${opts.timeoutHint ? ` — ${opts.timeoutHint}` : ""}`;
    ctl.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    abortDetail = "aborted by user";
    ctl.abort();
  };
  const external = opts.externalSignal;
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  const registryAbort = (detail: string) => {
    abortDetail = detail;
    ctl.abort();
  };
  activeRuns.add(registryAbort);
  notifyActiveRuns();
  try {
    const result = await Promise.race([
      fn({ signal: ctl.signal }),
      new Promise<never>((_, rej) => {
        const rejNow = () => rej(new Error(abortDetail || "aborted"));
        if (ctl.signal.aborted) rejNow();
        else ctl.signal.addEventListener("abort", rejNow, { once: true });
      }),
    ]);
    if (typeof result === "string") return result;
    if (result === undefined || result === null) return "ok";
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  } catch (e) {
    return toolError(tool, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
    activeRuns.delete(registryAbort);
    notifyActiveRuns();
  }
}

/** Squashes whitespace and truncates a response-body snippet for error strings. */
function bodySnippet(text: string, max = 200): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** JSON request/response helper for tool handlers. Never throws. Pass the
 *  kernel `signal` via `init` so the configured timeout cancels the fetch. */
export async function fetchToolJson(
  tool: string,
  input: RequestInfo,
  init?: RequestInit,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    return { ok: false, error: toolError(tool, e instanceof Error ? e.message : String(e)) };
  }
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, error: toolError(tool, `failed reading response body: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (!res.ok) {
    const detail = bodySnippet(text);
    const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    return { ok: false, error: toolError(tool, detail ? `${status}: ${detail}` : status) };
  }
  try {
    return { ok: true, data: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { ok: false, error: toolError(tool, `invalid JSON in response body: ${bodySnippet(text)}`) };
  }
}

/** NDJSON stream consumer with an IDLE timeout: the deadline resets on every
 *  received chunk and fires only after `idleMs` of silence, so long-running
 *  but chatty streams (delegations, workflows) are never cut off mid-work.
 *  Calls `onLine` with each trimmed, non-empty line (a trailing unterminated
 *  line is flushed at stream end). Never throws; on idle expiry the reader is
 *  cancelled and the returned error carries `idleHint` (which must truthfully
 *  say the server side may still be running). */
export async function readNdjsonStream(
  tool: string,
  res: Response,
  onLine: (line: string) => void,
  idleMs: number,
  idleHint: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!res.body) return { ok: false, error: toolError(tool, "no response stream") };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      // Cancelling resolves the pending read() with { done: true }.
      void reader.cancel().catch(() => {});
    }, idleMs);
  };
  try {
    armIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || idle) break;
      armIdle();
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (s) onLine(s);
      }
    }
    if (!idle) {
      const tail = (buf + dec.decode()).trim();
      if (tail) onLine(tail);
    }
  } catch (e) {
    if (!idle) return { ok: false, error: toolError(tool, e instanceof Error ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
  if (idle) {
    return { ok: false, error: toolError(tool, `stream idle for ${Math.round(idleMs / 1000)}s`, idleHint) };
  }
  return { ok: true };
}
