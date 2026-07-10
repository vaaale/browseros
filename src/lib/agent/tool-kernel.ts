// Framework-free tool-execution kernel (client-side). No "use client" needed:
// pure functions + fetch; imported by the *Actions.tsx components.
//
// Phase 1 of the assistant-robustness plan: the configured tool-call timeout
// accessor. Phase 2 grows this module with runToolHandler / fetchToolJson /
// readNdjsonStream.

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
