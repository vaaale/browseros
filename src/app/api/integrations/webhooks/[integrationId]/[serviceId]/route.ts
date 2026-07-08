import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { emitNotification } from "@/lib/integrations/notifications/store";
import { readState, mutateState } from "@/lib/integrations/state/store";
import { getWebhookHandler } from "@/lib/integrations/webhooks/registry";
import {
  readWebhookConfig,
  readWebhookSecrets,
} from "@/lib/integrations/webhooks/store";
import { hashPayload, markDelivery } from "@/lib/integrations/webhooks/verify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/webhooks/[integrationId]/[serviceId]
//
// Generic webhook receiver.
//   1. Look up handler + config + secrets. 404 if no handler registered.
//   2. Reject if config.enabled === false (404 rather than 401 — no leak).
//   3. Read raw body ONCE (all downstream steps get it as a string).
//   4. Delegate verification to the handler. 401 on failure.
//   5. Idempotency: hash provider-messageId + body; drop dup deliveries.
//   6. Delegate parsing to the handler; emit each returned event.
//   7. Update state.services[svcId].lastSync so the UI shows "last received".
//
// Response body: `{ ok: true, emitted: N }` on success, or the handler's
// custom ack if it returned one. Never leaks the body/hash.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ integrationId: string; serviceId: string }> },
) {
  const { integrationId, serviceId } = await params;

  const handler = getWebhookHandler(integrationId, serviceId);
  if (!handler) {
    return NextResponse.json(
      { error: { code: "no_handler", message: `No webhook handler for ${integrationId}/${serviceId}` } },
      { status: 404 },
    );
  }

  const config = await readWebhookConfig(integrationId, serviceId);
  if (!config?.enabled) {
    // Return 404 instead of 401 so a probing attacker can't distinguish an
    // enabled-but-unauthenticated webhook from a fully-disabled one.
    return NextResponse.json(
      { error: { code: "not_enabled", message: "Webhook disabled" } },
      { status: 404 },
    );
  }

  // Confirm the integration is connected — a disconnected integration cannot
  // meaningfully process events even if the shared secret is still valid.
  const state = await readState(integrationId);
  if (!state.connected) {
    return NextResponse.json(
      { error: { code: "not_connected", message: "Integration is not connected" } },
      { status: 404 },
    );
  }

  const body = await req.text();
  const secrets = await readWebhookSecrets(integrationId, serviceId);

  let verified = false;
  try {
    verified = await handler.verify({ req, body, secrets, config });
  } catch {
    verified = false;
  }
  if (!verified) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Signature verification failed" } },
      { status: 401 },
    );
  }

  // Idempotency — hash the messageId (or its absence) + body. Providers that
  // include an idempotency token (Google Pub/Sub `messageId`, Stripe
  // `Idempotency-Key`) benefit from a stable hash; the body-only fallback
  // still catches retries with byte-identical payloads.
  const idKey =
    req.headers.get("x-goog-message-id") ??
    req.headers.get("x-idempotency-key") ??
    req.headers.get("idempotency-key") ??
    "";
  const digest = hashPayload(integrationId, serviceId, idKey, body);
  if (markDelivery(digest)) {
    // Duplicate — ack success so the provider stops retrying.
    return NextResponse.json({ ok: true, dedup: true, emitted: 0 });
  }

  let result: Awaited<ReturnType<typeof handler.receive>>;
  try {
    result = await handler.receive({ req, body, config });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "handler_failed", message: (err as Error).message ?? "handler failed" } },
      { status: 500 },
    );
  }
  let emitted = 0;
  for (const ev of result.events) {
    // Optional event-type filter — the framework applies it here so handlers
    // don't have to repeat themselves.
    if (config.eventTypes && config.eventTypes.length > 0 && !config.eventTypes.includes(ev.type)) {
      continue;
    }
    await emitNotification(ev);
    emitted++;
  }

  // Reflect delivery on the service state — mirrors the poll path.
  await mutateState(integrationId, (prev) => ({
    ...prev,
    services: {
      ...prev.services,
      [serviceId]: {
        ...(prev.services[serviceId] ?? { enabled: false, config: {} }),
        lastSync: Date.now(),
        error: undefined,
      },
    },
  })).catch(() => {});

  if (result.ack) {
    return NextResponse.json(result.ack);
  }
  return NextResponse.json({ ok: true, emitted });
}
