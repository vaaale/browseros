// Adapter → assistant-tool naming + invocation helpers, shared by the server
// tool registry (src/lib/assistant/tools/server/integrations.ts) and the
// capabilities registry. Framework-free (no react, no server-only) — the
// actual adapter call happens over HTTP via
// `/api/integrations/[id]/services/[serviceId]/invoke`, so the browser bundle
// (client-side tool-metadata reads) stays free of Node/Google APIs.
//
// One tool per adapter method. Naming convention (see docs/dev/integrations.md
// and capabilities-registry.ts):
//
//   <serviceId>_<object>_<verb>   (snake_case)
//   e.g. gmail_messages_list, drive_files_list, calendar_events_create
//
// The integration id (e.g. `gsuite`) is deliberately NOT included in the
// action name — service ids (gmail, drive, calendar, contacts, …) are unique
// across BOS's registered integrations and the shorter name reads better in
// LLM tool listings.
//
// The `<object>_<verb>` tail is the adapter method's descriptor id (see the
// GmailMethodName / DriveMethodName / CalendarMethodName / ContactsMethodName
// unions in each adapter's `*-methods.ts`).
//
// Scope gating is done in TWO places:
//   - Tool visibility: the capabilities registry's allowlist/deferred gating
//     means the LLM only sees tools it's allowed to use.
//   - Server: the invoke route re-checks scopes via ServiceAdapter.withScope
//     (defence-in-depth; tool visibility is presentation, not authorization).

/**
 * Build the assistant tool name for an adapter method. Kept in one place so
 * the tool registry, the capabilities registry, and the invoke route agree.
 *
 * The integrationId argument is accepted for callsite documentation (which
 * integration this action belongs to) but intentionally not embedded in the
 * name — service ids are already unique across integrations.
 */
export function actionNameFor(
  _integrationId: string,
  serviceId: string,
  method: string,
): string {
  return `${serviceId}_${method}`;
}

/**
 * Fetch the invoke endpoint and return the parsed JSON. Consolidated here so
 * every action's handler uses the exact same request shape and error contract.
 *
 * Contract:
 *  - 200 → `{ result: unknown }` (adapter return value)
 *  - 4xx → `{ error: { code, message, scope?, integrationId? } }`
 *
 * Errors are re-thrown with a stable `.code` so the LLM can differentiate
 * scope errors from generic failures (see docs/dev/integrations.md §Errors).
 */
export async function invokeAdapterMethod(input: {
  integrationId: string;
  serviceId: string;
  method: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const url = `/api/integrations/${encodeURIComponent(input.integrationId)}/services/${encodeURIComponent(input.serviceId)}/invoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: input.method, args: input.args }),
    signal: input.signal,
  });
  const body = (await res.json().catch(() => ({}))) as {
    result?: unknown;
    error?: { code?: string; message?: string; scope?: string; integrationId?: string };
  };
  if (!res.ok) {
    const err = body.error ?? { code: "unknown", message: `HTTP ${res.status}` };
    const e = new Error(err.message ?? `HTTP ${res.status}`) as Error & {
      code?: string;
      scope?: string;
      integrationId?: string;
    };
    e.code = err.code;
    e.scope = err.scope;
    e.integrationId = err.integrationId;
    throw e;
  }
  return body.result;
}
