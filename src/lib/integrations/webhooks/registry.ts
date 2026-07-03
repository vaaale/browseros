import "server-only";
import type { WebhookHandler } from "./handler";
import { GmailWebhookHandler } from "../services/gsuite/adapters/gmail-webhook";

// Server-side lookup: for a given (integrationId, serviceId), return the
// registered handler. Modelled after `actions/adapter-registry.ts`.
//
// Adding a new webhook handler is one entry here + the handler impl.

const HANDLERS: Record<string, Record<string, WebhookHandler>> = {
  gsuite: {
    gmail: new GmailWebhookHandler(),
  },
};

export function getWebhookHandler(integrationId: string, serviceId: string): WebhookHandler | undefined {
  return HANDLERS[integrationId]?.[serviceId];
}

export function listWebhookHandlers(): Array<{ integrationId: string; serviceId: string }> {
  const out: Array<{ integrationId: string; serviceId: string }> = [];
  for (const [integrationId, services] of Object.entries(HANDLERS)) {
    for (const serviceId of Object.keys(services)) {
      out.push({ integrationId, serviceId });
    }
  }
  return out;
}
