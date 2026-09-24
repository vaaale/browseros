import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import type { WebhookHandler } from "../../../webhooks/handler";
import type { WebhookConfig, WebhookReceiveResult, WebhookSecrets } from "../../../webhooks/types";
import { IntegrationError } from "../../../errors";
import { writeIndexEntry, removeIndexEntry } from "@/lib/secrets/credentials-index";
import { readBotToken } from "../auth";
import { telegramFetch } from "../client";
import { updateToEvent, type TelegramUpdate } from "./bot";

// Telegram webhook handler.
//
// Verification: Telegram's `setWebhook` accepts a `secret_token` (1–256 chars,
// charset [A-Za-z0-9_-]). When set, every incoming push carries the header
//   X-Telegram-Bot-Api-Secret-Token: <secret>
// The receiver rejects requests without a matching header.
//
// A secret token is ALWAYS registered: `extras.secretToken` if the user typed
// one, otherwise the framework-minted `WebhookSecrets.primary` (hex — a subset
// of Telegram's allowed charset) that `enableWebhook` guarantees exists before
// calling onEnable. This is load-bearing beyond verification: on a
// Bastion-fronted multi-user deployment the delivery carries no cookie and no
// Authorization header, so the secret header is the ONLY thing Bastion can
// route by. onEnable therefore also records sha256(secret) in the
// credentials-index companion file (034-secrets-authentication) under the
// service name "telegram-webhook"; Bastion resolves the header against that
// index and forwards the request to this container, where verify() stays the
// authoritative check.
//
// Payload: Telegram POSTs the raw Update JSON — same shape as one element of
// the `getUpdates` response. We translate it into a BOS IntegrationEvent via
// the shared `updateToEvent`, so long-poll and webhook produce identical
// downstream events.

/** Credentials-index service name for Bastion webhook routing. */
const ROUTING_SERVICE = "telegram-webhook";

interface TelegramWebhookExtras {
  /** Optional shared secret expected in `X-Telegram-Bot-Api-Secret-Token`.
   *  Overrides the framework-minted WebhookSecrets.primary when set. */
  secretToken?: string;
  /** Update types to receive (see https://core.telegram.org/bots/api#update). */
  allowedUpdates?: string[];
  /** Cached URL the last `setWebhook` call registered. Used for display. */
  registeredUrl?: string;
  /** sha256 of the secret last written to the credentials index — kept so
   *  disable (and a later enable with a different secret) can remove exactly
   *  the entry this handler created. Not secret material: it is the same
   *  value the index itself stores in plaintext. */
  routingSecretHash?: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** The secret Telegram should echo back on every delivery: the user-typed
 *  override when present, else the framework-minted primary. */
function effectiveSecretToken(extras: TelegramWebhookExtras, secrets: WebhookSecrets | null): string | undefined {
  return extras.secretToken?.trim() || secrets?.primary;
}

export class TelegramBotWebhookHandler implements WebhookHandler {
  async verify(input: {
    req: NextRequest;
    body: string;
    secrets: WebhookSecrets | null;
    config: WebhookConfig;
  }): Promise<boolean> {
    const extras = (input.config.extras ?? {}) as TelegramWebhookExtras;
    // Accept the user-typed override plus the framework secrets — `previous`
    // included so rotation has the same grace window the HMAC scheme gets.
    const candidates = [extras.secretToken?.trim(), input.secrets?.primary, input.secrets?.previous].filter(
      (s): s is string => Boolean(s),
    );
    // No secret exists anywhere (legacy config enabled before secrets were
    // minted) — accept every request rather than bricking the webhook.
    if (candidates.length === 0) return true;
    const provided = input.req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    return candidates.some((expected) => timingSafeStringEqual(expected, provided));
  }

  async receive(input: {
    req: NextRequest;
    body: string;
    config: WebhookConfig;
  }): Promise<WebhookReceiveResult> {
    let update: TelegramUpdate;
    try {
      update = JSON.parse(input.body) as TelegramUpdate;
    } catch {
      return { events: [] };
    }
    if (!update || typeof update.update_id !== "number") return { events: [] };
    // Fire agent routing alongside notification emission. Dynamic import keeps
    // the module graph acyclic (agent-router imports client/auth from this
    // service). routeUpdate never throws.
    const { routeUpdate } = await import("../agent-router");
    await routeUpdate(update);
    // Muted-chat filter: drop events whose chat has been muted locally (see
    // notification-handler / user-cache). Framework webhook receiver emits
    // whatever we return here directly into the shared notifications inbox.
    const { filterMutedEvents } = await import("../notification-handler");
    const events = await filterMutedEvents([updateToEvent(update)]);
    return { events };
  }

  async onEnable(input: {
    integrationId: string;
    serviceId: string;
    config: WebhookConfig;
    origin?: string;
  }): Promise<void> {
    const token = await readBotToken();
    if (!token) {
      throw new Error(
        "Cannot enable Telegram webhook — bot token missing. Connect the bot first in Settings → Integrations → Telegram.",
      );
    }
    const extras = (input.config.extras ?? {}) as TelegramWebhookExtras;
    const { readWebhookSecrets } = await import("../../../webhooks/store");
    const secrets = await readWebhookSecrets(input.integrationId, input.serviceId);
    const secretToken = effectiveSecretToken(extras, secrets);
    const resolvedOrigin = (input.origin ?? process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
    const url = `${resolvedOrigin}/api/integrations/webhooks/telegram/bot`;
    const body: Record<string, unknown> = { url };
    if (secretToken) body.secret_token = secretToken;
    if (extras.allowedUpdates?.length) body.allowed_updates = extras.allowedUpdates;
    const registered = await telegramFetch<boolean>(token, "setWebhook", body);
    // Telegram can accept the call (`ok: true`) yet refuse the registration
    // (`result: false`) — e.g. unreachable host or bad certificate. The
    // refusal's cause is only reported via getWebhookInfo's last_error_message,
    // so fetch it and fail loudly instead of persisting a dead webhook.
    if (registered === false) {
      const info = await telegramFetch<{ last_error_message?: string }>(token, "getWebhookInfo");
      const detail = info?.last_error_message ?? "Telegram did not report an error description";
      throw new IntegrationError(
        "telegram_webhook_registration_failed",
        `setWebhook: Telegram refused to register ${url} — ${detail}`,
        { integrationId: "telegram" },
      );
    }
    // Record the secret in the Bastion routing companion index so a fronted
    // deployment can resolve the delivery's header to this container. If the
    // effective secret changed since the last enable, drop the stale entry —
    // a revoked secret must stop routing immediately.
    const routingSecretHash = secretToken ? sha256Hex(secretToken) : undefined;
    if (extras.routingSecretHash && extras.routingSecretHash !== routingSecretHash) {
      await removeIndexEntry(extras.routingSecretHash);
    }
    if (routingSecretHash) {
      await writeIndexEntry(routingSecretHash, ROUTING_SERVICE);
    }
    // Persist the registered URL (for display) + the index hash (for teardown).
    const { writeWebhookConfig } = await import("../../../webhooks/store");
    await writeWebhookConfig(input.integrationId, input.serviceId, {
      ...input.config,
      extras: { ...extras, registeredUrl: url, routingSecretHash } as Record<string, unknown>,
    });
  }

  async onDisable(input: { integrationId: string; serviceId: string }): Promise<void> {
    const token = await readBotToken();
    if (token) {
      try {
        await telegramFetch<boolean>(token, "deleteWebhook", { drop_pending_updates: false });
      } catch {
        // Best-effort — provider-side teardown failures shouldn't block the UI.
      }
    }
    // Clear the registered URL from extras so the UI reflects the state, and
    // remove the routing index entry so Bastion stops routing the secret.
    const { readWebhookConfig, writeWebhookConfig } = await import("../../../webhooks/store");
    const current = await readWebhookConfig(input.integrationId, input.serviceId);
    if (!current) return;
    const extras: TelegramWebhookExtras = { ...((current.extras ?? {}) as TelegramWebhookExtras) };
    if (extras.routingSecretHash) {
      await removeIndexEntry(extras.routingSecretHash);
    }
    delete extras.registeredUrl;
    delete extras.routingSecretHash;
    await writeWebhookConfig(input.integrationId, input.serviceId, {
      ...current,
      extras: { ...extras } as Record<string, unknown>,
    });
  }
}
