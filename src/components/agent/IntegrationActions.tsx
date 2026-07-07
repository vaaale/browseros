"use client";

import { useCopilotReadable, useCopilotAction } from "@copilotkit/react-core";
import { useIntegrationsEffectiveScopes } from "@/components/apps/settings/integrations/useIntegrations";
import { GMAIL_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/gmail-methods";
import { DRIVE_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/drive-methods";
import { CALENDAR_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/calendar-methods";
import { CONTACTS_METHOD_DESCRIPTORS } from "@/lib/integrations/services/gsuite/adapters/contacts-methods";
import { TELEGRAM_BOT_METHOD_DESCRIPTORS } from "@/lib/integrations/services/telegram/adapters/bot-methods";
import {
  actionNameFor,
  invokeAdapterMethod,
  toCopilotParameter,
} from "@/lib/integrations/actions/dispatcher";

// Registers one CopilotKit action per adapter method. Every action is rendered
// on every render (never conditionally mounted / unmounted) — the number of
// hook calls is fixed at compile time by the *_METHOD_DESCRIPTORS lengths.
// The `available` flag on each action reflects the effective-scope set
// (granted ∩ enabled) so the LLM only sees actions it can actually use. The
// server-side invoke route re-checks scopes (defence-in-depth).
//
// KEYING NOTE: each GsuiteMethodAction is keyed by `<name>:<on|off>`. That is
// intentional — CopilotKit's `useCopilotAction` captures the action's config
// TYPE (render vs frontend) in `useState` on first render, then throws
// "Action configuration changed between renders" if a subsequent render maps
// to a different type. Toggling `available` between "enabled" (frontend) and
// "disabled" (render) crosses that boundary, so we force React to remount
// the leaf component when scopeGranted flips. Fresh mount → fresh useState →
// no cross-render type flip.
//
// NAMING: actions here are `<serviceId>_<object>_<verb>` in snake_case (e.g.
// `gmail_messages_list`, `drive_files_list`, `calendar_events_create`). The
// integration id (`gsuite`) is intentionally NOT included in the name — see
// dispatcher.ts and capabilities-registry.ts for the shared convention.
export function IntegrationActions() {
  const { byIntegration, connected } = useIntegrationsEffectiveScopes();
  const gsuiteScopes = byIntegration["gsuite"] ?? new Set<string>();
  const gsuiteConnected = connected["gsuite"] ?? false;
  const telegramScopes = byIntegration["telegram"] ?? new Set<string>();
  const telegramConnected = connected["telegram"] ?? false;

  useCopilotReadable({
    description:
      "Connected external integrations (Gmail / Drive / Calendar / Contacts / GSuite / Telegram): which are connected and which scopes are effectively granted right now. If an action is disabled, ask the user to connect the integration or enable the missing scope in Settings → Integrations.",
    value: {
      gsuite: {
        connected: gsuiteConnected,
        effectiveScopes: Array.from(gsuiteScopes),
      },
      telegram: {
        connected: telegramConnected,
        effectiveScopes: Array.from(telegramScopes),
      },
    },
  });

  // Static-length map over compile-time descriptors: number of hook calls is
  // stable across renders (Rules of Hooks) because *_METHOD_DESCRIPTORS are
  // readonly module constants.
  return (
    <>
      {GMAIL_METHOD_DESCRIPTORS.map((d) => {
        const scopeGranted = gsuiteScopes.has(d.scope) && gsuiteConnected;
        return (
          <GsuiteMethodAction
            key={`gmail_${d.method}:${scopeGranted ? "on" : "off"}`}
            serviceId="gmail"
            method={d.method}
            scope={d.scope}
            description={d.description}
            parameters={d.parameters}
            scopeGranted={scopeGranted}
          />
        );
      })}
      {DRIVE_METHOD_DESCRIPTORS.map((d) => {
        const scopeGranted = gsuiteScopes.has(d.scope) && gsuiteConnected;
        return (
          <GsuiteMethodAction
            key={`drive_${d.method}:${scopeGranted ? "on" : "off"}`}
            serviceId="drive"
            method={d.method}
            scope={d.scope}
            description={d.description}
            parameters={d.parameters}
            scopeGranted={scopeGranted}
          />
        );
      })}
      {CALENDAR_METHOD_DESCRIPTORS.map((d) => {
        const scopeGranted = gsuiteScopes.has(d.scope) && gsuiteConnected;
        return (
          <GsuiteMethodAction
            key={`calendar_${d.method}:${scopeGranted ? "on" : "off"}`}
            serviceId="calendar"
            method={d.method}
            scope={d.scope}
            description={d.description}
            parameters={d.parameters}
            scopeGranted={scopeGranted}
          />
        );
      })}
      {CONTACTS_METHOD_DESCRIPTORS.map((d) => {
        const scopeGranted = gsuiteScopes.has(d.scope) && gsuiteConnected;
        return (
          <GsuiteMethodAction
            key={`contacts_${d.method}:${scopeGranted ? "on" : "off"}`}
            serviceId="contacts"
            method={d.method}
            scope={d.scope}
            description={d.description}
            parameters={d.parameters}
            scopeGranted={scopeGranted}
          />
        );
      })}
      {TELEGRAM_BOT_METHOD_DESCRIPTORS.map((d) => {
        const scopeGranted = telegramScopes.has(d.scope) && telegramConnected;
        return (
          <TelegramMethodAction
            key={`telegram_bot_${d.method}:${scopeGranted ? "on" : "off"}`}
            serviceId="bot"
            method={d.method}
            scope={d.scope}
            description={d.description}
            parameters={d.parameters}
            scopeGranted={scopeGranted}
          />
        );
      })}
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
 *
 * The parent flips `key` on scope changes so this component remounts and
 * `useCopilotAction`'s internal `useState(getActionConfig(action))` re-runs
 * from scratch (avoids the "Action configuration changed between renders"
 * crash when `available` flips between "enabled" and "disabled").
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

interface TelegramActionProps {
  serviceId: string;
  method: string;
  scope: string;
  description: string;
  parameters: ReadonlyArray<{ name: string; type: string; description: string; required?: boolean }>;
  scopeGranted: boolean;
}

/**
 * One CopilotKit action for a single Telegram adapter method. Mirrors the
 * GsuiteMethodAction pattern — same static-hook / remount-on-availability
 * discipline; only the invoke integrationId differs.
 */
function TelegramMethodAction({
  serviceId,
  method,
  scope,
  description,
  parameters,
  scopeGranted,
}: TelegramActionProps): null {
  const name = actionNameFor("telegram", serviceId, method);
  const availability: "enabled" | "disabled" = scopeGranted ? "enabled" : "disabled";
  const fullDescription = scopeGranted
    ? description
    : `${description}\n\n(Currently unavailable — requires the '${scope}' scope. Ask the user to connect Telegram or enable this scope in Settings → Integrations.)`;

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
          integrationId: "telegram",
          serviceId,
          method,
          args: args ?? {},
        });
        const json = JSON.stringify(result);
        if (json.length > 8_000) {
          return `${json.slice(0, 8_000)}\n\n… response truncated at 8 KB.`;
        }
        return json;
      } catch (err) {
        const e = err as Error & { code?: string; scope?: string };
        if (e.code === "scope_disabled") {
          return `Error: scope '${e.scope}' is not enabled for telegram. Ask the user to enable it in Settings → Integrations → Telegram, or to reconnect if it isn't granted.`;
        }
        if (e.code === "auth_failed") {
          return `Error: Telegram bot token is missing or revoked. Ask the user to reconnect in Settings → Integrations → Telegram.`;
        }
        if (e.code === "config_invalid") {
          return `Error: Telegram is not configured (${e.message}). Ask the user to add a bot token in Settings → Integrations → Telegram.`;
        }
        if (e.code === "not_implemented") {
          return `Error: ${e.message}`;
        }
        return `Error: ${e.message ?? "call failed"}`;
      }
    },
  });
  return null;
}
