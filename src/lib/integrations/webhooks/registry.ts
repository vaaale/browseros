import "server-only";
import type { WebhookHandler } from "./handler";
import { GmailWebhookHandler } from "../services/gsuite/adapters/gmail-webhook";
import { TelegramBotWebhookHandler } from "../services/telegram/adapters/bot-webhook";

// Server-side lookup: for a given (integrationId, serviceId), return the
// registered handler. Modelled after `actions/adapter-registry.ts`.
//
// Adding a new webhook handler is one entry here + the handler impl.

const HANDLERS: Record<string, Record<string, WebhookHandler>> = {
  gsuite: {
    gmail: new GmailWebhookHandler(),
  },
  telegram: {
    bot: new TelegramBotWebhookHandler(),
  },
};

const DYNAMIC_KEY = "__bos_webhook_handlers__" as const;

function getDynamic(): Record<string, Record<string, WebhookHandler>> {
  const g = globalThis as Record<string, unknown>;
  if (!g[DYNAMIC_KEY]) g[DYNAMIC_KEY] = {};
  return g[DYNAMIC_KEY] as Record<string, Record<string, WebhookHandler>>;
}

export function registerWebhookHandler(
  integrationId: string,
  serviceId: string,
  handler: WebhookHandler,
): void {
  const d = getDynamic();
  if (!d[integrationId]) d[integrationId] = {};
  d[integrationId][serviceId] = handler;
}

export function unregisterWebhookHandler(integrationId: string, serviceId: string): void {
  const d = getDynamic();
  if (d[integrationId]) delete d[integrationId][serviceId];
}

export function getWebhookHandler(integrationId: string, serviceId: string): WebhookHandler | undefined {
  return getDynamic()[integrationId]?.[serviceId] ?? HANDLERS[integrationId]?.[serviceId];
}

export function listWebhookHandlers(): Array<{ integrationId: string; serviceId: string }> {
  const out: Array<{ integrationId: string; serviceId: string }> = [];
  const seen = new Set<string>();
  for (const [integrationId, services] of Object.entries(getDynamic())) {
    for (const serviceId of Object.keys(services)) {
      out.push({ integrationId, serviceId });
      seen.add(`${integrationId}/${serviceId}`);
    }
  }
  for (const [integrationId, services] of Object.entries(HANDLERS)) {
    for (const serviceId of Object.keys(services)) {
      if (!seen.has(`${integrationId}/${serviceId}`)) {
        out.push({ integrationId, serviceId });
      }
    }
  }
  return out;
}
