// Adapter → CopilotKit action dispatcher.
//
// Framework-free (no react, no server-only) — safe to import from client code
// that mounts CopilotKit actions. The actual adapter call happens over HTTP
// via `/api/integrations/[id]/services/[serviceId]/invoke`, so the browser
// bundle stays free of Node/Google APIs.
//
// One CopilotKit action per adapter method. Naming convention (see
// docs/dev/integrations.md and capabilities-registry.ts):
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
//   - Client: `available` on the action reflects the effective-scope set so
//     the LLM only sees actions it can actually invoke.
//   - Server: the invoke route re-checks scopes via ServiceAdapter.withScope
//     (defence-in-depth; the client flag is presentation, not authorization).

import type { AdapterMethodMeta, AdapterMethodParameter } from "./types";

/**
 * A CopilotKit-shaped parameter descriptor. We keep this locally-typed rather
 * than importing from @copilotkit/shared to avoid making this file client-only
 * (server code — including tests — also imports the metadata utilities here).
 */
export interface CopilotActionParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "string[]" | "number[]" | "boolean[]" | "object[]";
  description: string;
  required?: boolean;
}

/**
 * Build the CopilotKit action name for an adapter method. Kept in one place so
 * the client (action registration) and server (invoke route routing) agree.
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
 * Translate a param-metadata entry into the CopilotKit action parameter shape
 * expected by `useCopilotAction`.
 */
export function toCopilotParameter(p: AdapterMethodParameter): CopilotActionParameter {
  return {
    name: p.name,
    type: p.type,
    description: p.description,
    required: p.required ?? false,
  };
}

/**
 * Describes what a UI-side dispatcher will register with CopilotKit. React
 * lives on the caller side (see `IntegrationActions.tsx`) so this file
 * remains framework-free and unit-testable.
 */
export interface AdapterActionDescriptor {
  name: string;
  description: string;
  parameters: CopilotActionParameter[];
  /** Full scope URL required for this action to be effective. */
  scope: string;
  /** Method id — used by the invoke route to look up the adapter method. */
  method: string;
  integrationId: string;
  serviceId: string;
}

export interface BuildDescriptorsInput {
  integrationId: string;
  serviceId: string;
  methods: readonly AdapterMethodMeta[];
}

/**
 * Convert a bundle of adapter method metadata into a list of CopilotKit
 * action descriptors. `IntegrationActions.tsx` walks the returned list and
 * calls `useCopilotAction` once per entry.
 */
export function buildAdapterActionDescriptors(input: BuildDescriptorsInput): AdapterActionDescriptor[] {
  return input.methods.map((m) => ({
    name: actionNameFor(input.integrationId, input.serviceId, m.method),
    description: m.description,
    parameters: m.parameters.map(toCopilotParameter),
    scope: m.scope,
    method: m.method,
    integrationId: input.integrationId,
    serviceId: input.serviceId,
  }));
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
