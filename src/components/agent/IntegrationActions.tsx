"use client";

import { useCopilotReadable } from "@copilotkit/react-core";
import { useCopilotAction } from "@/components/agent/gated-action";
import { useIntegrationsEffectiveScopes } from "@/components/apps/settings/integrations/useIntegrations";
import { GMAIL_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/gmail-methods";
import { DRIVE_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/drive-methods";
import {
  actionNameFor,
  invokeAdapterMethod,
  toCopilotParameter,
} from "@/lib/integrations/actions/dispatcher";

// Registers one CopilotKit action per adapter method. `available` is driven by
// the user's effective-scope set (granted ∩ enabled), so the LLM only sees
// actions it can actually use. The server-side invoke route re-checks scopes
// (defence-in-depth) — see /api/integrations/[id]/services/[serviceId]/invoke.
//
// NAMING: actions here are `<integrationId>_<serviceId>_<method>` in the
// adapter's own camelCase (e.g. gsuite_gmail_listMessages). This is the ONLY
// explicit exception to the codebase's snake_case action naming — see the
// Integrations group in capabilities-registry.ts.
export function IntegrationActions() {
  const { byIntegration, connected } = useIntegrationsEffectiveScopes();
  const gsuiteScopes = byIntegration["gsuite"] ?? new Set<string>();
  const gsuiteConnected = connected["gsuite"] ?? false;

  useCopilotReadable({
    description:
      "Connected external integrations (Gmail / Drive / GSuite): which are connected and which scopes are effectively granted right now. If an action is disabled, ask the user to connect the integration or enable the missing scope in Settings → Integrations.",
    value: {
      gsuite: {
        connected: gsuiteConnected,
        effectiveScopes: Array.from(gsuiteScopes),
      },
    },
  });

  // Static-length map over compile-time descriptors: number of hook calls is
  // stable across renders (Rules of Hooks) because *_METHOD_DESCRIPTORS are
  // readonly module constants.
  return (
    <>
      {GMAIL_METHOD_DESCRIPTORS.map((d) => (
        <GsuiteMethodAction
          key={`gmail_${d.method}`}
          serviceId="gmail"
          method={d.method}
          scope={d.scope}
          description={d.description}
          parameters={d.parameters}
          scopeGranted={gsuiteScopes.has(d.scope) && gsuiteConnected}
        />
      ))}
      {DRIVE_METHOD_DESCRIPTORS.map((d) => (
        <GsuiteMethodAction
          key={`drive_${d.method}`}
          serviceId="drive"
          method={d.method}
          scope={d.scope}
          description={d.description}
          parameters={d.parameters}
          scopeGranted={gsuiteScopes.has(d.scope) && gsuiteConnected}
        />
      ))}
    </>
  );
}

interface GsuiteActionProps {
  serviceId: string;
  method: string;
  scope: string;
  description: string;
  parameters: ReadonlyArray<{ name: string; type: string; description: string; required?: boolean }>;
  scopeGranted: boolean;
}

/**
 * One CopilotKit action for a single GSuite adapter method. Split out so each
 * useCopilotAction is a static hook call in its own component tree — the
 * parent's `.map()` renders a stable number of children (equal to the
 * summed length of the compile-time descriptor lists).
 */
function GsuiteMethodAction({
  serviceId,
  method,
  scope,
  description,
  parameters,
  scopeGranted,
}: GsuiteActionProps): null {
  const name = actionNameFor("gsuite", serviceId, method);
  // `available` drives whether the LLM sees the action. Adding an explicit
  // scope hint to the description gives the model a chance to ask the user
  // to grant the missing scope instead of just retrying blindly.
  const availability: "enabled" | "disabled" = scopeGranted ? "enabled" : "disabled";
  const fullDescription = scopeGranted
    ? description
    : `${description}\n\n(Currently unavailable — requires the '${scope}' scope. Ask the user to connect GSuite or enable this scope in Settings → Integrations.)`;

  useCopilotAction({
    name,
    description: fullDescription,
    available: availability,
    parameters: parameters.map((p) =>
      toCopilotParameter({
        name: p.name,
        type: p.type as ReturnType<typeof toCopilotParameter>["type"],
        description: p.description,
        required: p.required,
      }),
    ),
    handler: async (args: Record<string, unknown>) => {
      try {
        const result = await invokeAdapterMethod({
          integrationId: "gsuite",
          serviceId,
          method,
          args: args ?? {},
        });
        // Trim large payloads so the LLM's context isn't blown out by a giant
        // list of messages / files. 8 KB is enough to preserve small responses
        // but avoids dumping raw bodies verbatim. Binary downloads (Drive)
        // already enforce their own maxBytes cap and return base64 that we
        // never truncate below its own limit.
        const json = JSON.stringify(result);
        if (json.length > 8_000) {
          return `${json.slice(0, 8_000)}\n\n… response truncated at 8 KB. Use a smaller pageSize / maxResults or fetch specific ids to see more.`;
        }
        return json;
      } catch (err) {
        const e = err as Error & { code?: string; scope?: string };
        if (e.code === "scope_disabled") {
          return `Error: scope '${e.scope}' is not enabled for gsuite. Ask the user to enable it in Settings → Integrations → GSuite, or to reconnect if it isn't granted.`;
        }
        if (e.code === "auth_failed") {
          return `Error: GSuite is not connected (auth_failed). Ask the user to connect it in Settings → Integrations.`;
        }
        if (e.code === "config_invalid") {
          return `Error: GSuite is misconfigured (${e.message}). Ask the user to upload client_secrets.json in Settings → Integrations → GSuite.`;
        }
        return `Error: ${e.message ?? "call failed"}`;
      }
    },
  });
  return null;
}
