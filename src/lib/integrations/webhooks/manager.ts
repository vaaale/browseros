import "server-only";
import { getWebhookHandler } from "./registry";
import {
  deleteWebhookSecrets,
  ensureWebhookSecret,
  readWebhookConfig,
  readWebhookSecrets,
  writeWebhookConfig,
} from "./store";
import type { WebhookConfig, WebhookSecrets } from "./types";

// Lifecycle façade for webhooks. The Settings UI + PATCH route call these:
//   - `enableWebhook(...)` — persist config, mint secret if missing, call
//     handler.onEnable (which may hit the provider to register the push).
//   - `disableWebhook(...)` — flip enabled=false + call handler.onDisable
//     (which may call the provider's tear-down endpoint).
//   - `rotateSecret(...)` — mint a new primary secret, demote the previous.
//   - `deleteWebhook(...)` — full teardown: disable + delete secrets.
//
// All three helpers return a small snapshot the UI can render, keeping the
// PATCH route logic trivial.

export interface WebhookSnapshot {
  config: WebhookConfig | undefined;
  hasSecret: boolean;
  /** URL the user should paste into the provider's push-subscription config. */
  url: string;
  /** Base URL derived from NEXT_PUBLIC_APP_ORIGIN, for display. */
  origin: string;
}

function computeOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Absolute URL the provider should POST to for this service. */
export function webhookUrl(integrationId: string, serviceId: string): string {
  return `${computeOrigin()}/api/integrations/webhooks/${encodeURIComponent(integrationId)}/${encodeURIComponent(serviceId)}`;
}

export async function getSnapshot(integrationId: string, serviceId: string): Promise<WebhookSnapshot> {
  const config = await readWebhookConfig(integrationId, serviceId);
  const secrets = await readWebhookSecrets(integrationId, serviceId);
  return {
    config,
    hasSecret: secrets !== null,
    url: webhookUrl(integrationId, serviceId),
    origin: computeOrigin(),
  };
}

export async function enableWebhook(input: {
  integrationId: string;
  serviceId: string;
  patch?: Partial<WebhookConfig>;
}): Promise<WebhookSnapshot> {
  const handler = getWebhookHandler(input.integrationId, input.serviceId);
  const config = await writeWebhookConfig(input.integrationId, input.serviceId, {
    ...input.patch,
    enabled: true,
  });
  await ensureWebhookSecret(input.integrationId, input.serviceId);
  if (handler?.onEnable) {
    await handler.onEnable({
      integrationId: input.integrationId,
      serviceId: input.serviceId,
      config,
    });
  }
  return getSnapshot(input.integrationId, input.serviceId);
}

export async function disableWebhook(input: {
  integrationId: string;
  serviceId: string;
}): Promise<WebhookSnapshot> {
  const handler = getWebhookHandler(input.integrationId, input.serviceId);
  await writeWebhookConfig(input.integrationId, input.serviceId, { enabled: false });
  if (handler?.onDisable) {
    // Best-effort — provider-side teardown failures shouldn't block the UI.
    await handler.onDisable({
      integrationId: input.integrationId,
      serviceId: input.serviceId,
    }).catch(() => {});
  }
  return getSnapshot(input.integrationId, input.serviceId);
}

export async function rotateSecret(input: {
  integrationId: string;
  serviceId: string;
}): Promise<{ secrets: WebhookSecrets; snapshot: WebhookSnapshot }> {
  const secrets = await ensureWebhookSecret(input.integrationId, input.serviceId, { force: true });
  const snapshot = await getSnapshot(input.integrationId, input.serviceId);
  return { secrets, snapshot };
}

export async function deleteWebhook(input: {
  integrationId: string;
  serviceId: string;
}): Promise<void> {
  await disableWebhook(input);
  await deleteWebhookSecrets(input.integrationId, input.serviceId);
}
