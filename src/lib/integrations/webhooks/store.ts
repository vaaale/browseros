import "server-only";
import { getSecretsStore } from "../secrets/store";
import { mutateState, readState } from "../state/store";
import type { WebhookConfig, WebhookSecrets } from "./types";
import { generateWebhookSecret } from "./verify";

// Persistence layer for webhook config + secrets.
//
// Config lives in the integration's `state.json` under
//   `services[svcId].config.webhook` (a `WebhookConfig`).
// Secrets live in the SecretsStore under
//   `webhook:<serviceId>` (a `WebhookSecrets`).
//
// This split matches Phase 1: non-sensitive metadata in state.json, sensitive
// key material behind AES-256 in secrets.json.

function secretsKey(serviceId: string): string {
  return `webhook:${serviceId}`;
}

/** Read the persisted webhook config for a (integration, service) pair. */
export async function readWebhookConfig(
  integrationId: string,
  serviceId: string,
): Promise<WebhookConfig | undefined> {
  const state = await readState(integrationId);
  const svc = state.services[serviceId];
  const cfg = svc?.config?.webhook as WebhookConfig | undefined;
  return cfg;
}

/**
 * Write a webhook config, merging into any existing service config so we
 * don't stomp on poll settings or other keys. Ensures the service entry
 * exists first.
 */
export async function writeWebhookConfig(
  integrationId: string,
  serviceId: string,
  patch: Partial<WebhookConfig>,
): Promise<WebhookConfig> {
  let next: WebhookConfig | undefined;
  await mutateState(integrationId, (prev) => {
    const services = { ...prev.services };
    const existing = services[serviceId] ?? { enabled: false, config: {} };
    const existingConfig = existing.config ?? {};
    const existingWebhook = (existingConfig.webhook as WebhookConfig | undefined) ?? { enabled: false };
    next = { ...existingWebhook, ...patch };
    services[serviceId] = {
      ...existing,
      config: {
        ...existingConfig,
        webhook: next,
      },
    };
    return { ...prev, services };
  });
  // `next` is set inside the updater which runs synchronously, so this is safe.
  return next as WebhookConfig;
}

/**
 * Load persisted secrets, or `null` if none exist yet. Callers pass what they
 * get straight to `verifySignature`.
 */
export async function readWebhookSecrets(
  integrationId: string,
  serviceId: string,
): Promise<WebhookSecrets | null> {
  return getSecretsStore().get<WebhookSecrets>(integrationId, secretsKey(serviceId));
}

/**
 * Ensure a webhook secret exists for the service. If none is present, mint a
 * new random one. Called by `onEnable` and by the "Regenerate secret" button
 * (with `force: true`).
 *
 * When `force` is true, the current `primary` is demoted to `previous` and a
 * new `primary` is minted — this gives us a short rotation window where the
 * previous secret still verifies successfully.
 */
export async function ensureWebhookSecret(
  integrationId: string,
  serviceId: string,
  opts: { force?: boolean } = {},
): Promise<WebhookSecrets> {
  const existing = await readWebhookSecrets(integrationId, serviceId);
  if (existing && !opts.force) return existing;
  const primary = generateWebhookSecret();
  const next: WebhookSecrets = {
    primary,
    previous: opts.force && existing ? existing.primary : undefined,
    rotatedAt: Date.now(),
  };
  await getSecretsStore().set(integrationId, secretsKey(serviceId), next);
  return next;
}

/** Delete persisted secrets. Called by disable/delete flows. */
export async function deleteWebhookSecrets(
  integrationId: string,
  serviceId: string,
): Promise<void> {
  await getSecretsStore().delete(integrationId, secretsKey(serviceId));
}
