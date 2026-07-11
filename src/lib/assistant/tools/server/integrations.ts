import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool } from "./util";
import { actionNameFor, invokeAdapterMethod } from "@/lib/integrations/actions/dispatcher";
import { GMAIL_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/gmail-methods";
import { DRIVE_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/drive-methods";
import { CALENDAR_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/calendar-methods";
import { CONTACTS_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/contacts-methods";
import { TELEGRAM_BOT_METHOD_DESCRIPTORS } from "@/lib/integrations/services/telegram/adapters/bot-methods";

// Integration tools (ported from IntegrationActions.tsx), generated from the
// adapter method descriptors. One tool per method; the invoke is server-side so
// no HTTP hop. Availability is enforced by the adapter: an unconfigured/unscoped
// integration returns a code (auth_failed / scope_disabled / config_invalid)
// that we map to a model-facing in-band Error string — the agent learns what to
// ask the user to fix. Large payloads are truncated at 8 KB like the old path.

interface MethodDescriptor {
  method: string;
  scope: string;
  description: string;
  parameters: ReadonlyArray<{ name: string; type: string; description: string; required?: boolean }>;
}

type AdapterError = Error & { code?: string; scope?: string };

function toSchema(parameters: MethodDescriptor["parameters"]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of parameters) {
    properties[param.name] = { type: param.type, description: param.description };
    if (param.required) required.push(param.name);
  }
  return { type: "object", properties, required };
}

function mapError(integrationId: string, label: string, e: AdapterError): string {
  if (e.code === "scope_disabled") {
    return `Error: scope '${e.scope}' is not enabled for ${integrationId}. Ask the user to enable it in Settings → Integrations → ${label}, or to reconnect if it isn't granted.`;
  }
  if (e.code === "auth_failed") {
    return `Error: ${label} is not connected (auth_failed). Ask the user to connect it in Settings → Integrations.`;
  }
  if (e.code === "config_invalid") {
    return `Error: ${label} is misconfigured (${e.message}). Ask the user to fix it in Settings → Integrations → ${label}.`;
  }
  return `Error: ${e.message ?? "call failed"}`;
}

function buildTools(
  descriptors: ReadonlyArray<MethodDescriptor>,
  opts: { integrationId: string; serviceId: string; nameServiceId: string; label: string },
): Record<string, AssistantTool> {
  const out: Record<string, AssistantTool> = {};
  for (const d of descriptors) {
    const name = actionNameFor(opts.integrationId, opts.nameServiceId, d.method);
    out[name] = serverTool(name, d.description, toSchema(d.parameters), async (input) => {
      try {
        const result = await invokeAdapterMethod({
          integrationId: opts.integrationId,
          serviceId: opts.serviceId,
          method: d.method,
          args: input ?? {},
        });
        const json = JSON.stringify(result);
        return json.length > 8_000
          ? `${json.slice(0, 8_000)}\n\n… response truncated at 8 KB. Use a smaller pageSize / maxResults or fetch specific ids to see more.`
          : json;
      } catch (err) {
        return mapError(opts.integrationId, opts.label, err as AdapterError);
      }
    });
  }
  return out;
}

export function integrationTools(): Record<string, AssistantTool> {
  return {
    ...buildTools(GMAIL_METHOD_DESCRIPTORS, { integrationId: "gsuite", serviceId: "gmail", nameServiceId: "gmail", label: "GSuite" }),
    ...buildTools(DRIVE_METHOD_DESCRIPTORS, { integrationId: "gsuite", serviceId: "drive", nameServiceId: "drive", label: "GSuite" }),
    ...buildTools(CALENDAR_METHOD_DESCRIPTORS, { integrationId: "gsuite", serviceId: "calendar", nameServiceId: "calendar", label: "GSuite" }),
    ...buildTools(CONTACTS_METHOD_DESCRIPTORS, { integrationId: "gsuite", serviceId: "contacts", nameServiceId: "contacts", label: "GSuite" }),
    ...buildTools(TELEGRAM_BOT_METHOD_DESCRIPTORS, { integrationId: "telegram", serviceId: "bot", nameServiceId: "bot", label: "Telegram" }),
  };
}
