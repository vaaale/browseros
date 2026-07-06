import "server-only";
import type { NextRequest } from "next/server";
import type { WebhookHandler } from "../../../webhooks/handler";
import type { WebhookConfig, WebhookReceiveResult, WebhookSecrets } from "../../../webhooks/types";
import { readBotToken } from "../auth";
import { telegramFetch } from "../client";
import { updateToEvent, type TelegramUpdate } from "./bot";

// Telegram webhook handler.
//
// Verification: Telegram's `setWebhook` accepts a `secret_token` (1–256 chars).
// When set, every incoming push carries the header
//   X-Telegram-Bot-Api-Secret-Token: <secret>
// The receiver rejects requests without a matching header.
//
// The framework's WebhookConfig lets the user set `extras.secretToken` — we
// also mirror this into the shared WebhookSecrets slot so the same rotation
// UI can regenerate it. For simplicity Phase 1 reads the secret from
// `config.extras.secretToken` (plaintext, stored in state.json under the bot
// service). Rotating means editing that value and calling setWebhook again.
//
// Payload: Telegram POSTs the raw Update JSON — same shape as one element of
// the `getUpdates` response. We translate it into a BOS IntegrationEvent via
// the shared `updateToEvent`, so long-poll and webhook produce identical
// downstream events.

interface TelegramWebhookExtras {
  /** Optional shared secret expected in `X-Telegram-Bot-Api-Secret-Token`. */
  secretToken?: string;
  /** Update types to receive (see https://core.telegram.org/bots/api#update). */
  allowedUpdates?: string[];
  /** Cached URL the last `setWebhook` call registered. Used for display. */
  registeredUrl?: string;
}

export class TelegramBotWebhookHandler implements WebhookHandler {
  async verify(input: {
    req: NextRequest;
    body: string;
    secrets: WebhookSecrets | null;
    config: WebhookConfig;
  }): Promise<boolean> {
    const extras = (input.config.extras ?? {}) as TelegramWebhookExtras;
    const expected = extras.secretToken?.trim();
    // No secret configured — accept every request (Telegram already knows the
    // URL; treat as best-effort). Users who care flip the secret on.
    if (!expected) return true;
    const provided = input.req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (provided.length !== expected.length) return false;
    // Constant-time compare via loop; length already checked.
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
    return diff === 0;
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
    return { events: [updateToEvent(update)] };
  }

  async onEnable(input: {
    integrationId: string;
    serviceId: string;
    config: WebhookConfig;
  }): Promise<void> {
    const token = await readBotToken();
    if (!token) {
      throw new Error(
        "Cannot enable Telegram webhook — bot token missing. Connect the bot first in Settings → Integrations → Telegram.",
      );
    }
    const extras = (input.config.extras ?? {}) as TelegramWebhookExtras;
    const origin = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
    const url = `${origin}/api/integrations/webhooks/telegram/bot`;
    const body: Record<string, unknown> = { url };
    if (extras.secretToken) body.secret_token = extras.secretToken;
    if (extras.allowedUpdates?.length) body.allowed_updates = extras.allowedUpdates;
    await telegramFetch<boolean>(token, "setWebhook", body);
    // Persist the registered URL for display.
    const { writeWebhookConfig } = await import("../../../webhooks/store");
    await writeWebhookConfig(input.integrationId, input.serviceId, {
      ...input.config,
      extras: { ...extras, registeredUrl: url } as Record<string, unknown>,
    });
  }

  async onDisable(input: { integrationId: string; serviceId: string }): Promise<void> {
    const token = await readBotToken();
    if (!token) return;
    try {
      await telegramFetch<boolean>(token, "deleteWebhook", { drop_pending_updates: false });
    } catch {
      // Best-effort — provider-side teardown failures shouldn't block the UI.
    }
    // Clear the registered URL from extras so the UI reflects the state.
    const { readWebhookConfig, writeWebhookConfig } = await import("../../../webhooks/store");
    const current = await readWebhookConfig(input.integrationId, input.serviceId);
    if (!current) return;
    const extras: TelegramWebhookExtras = { ...((current.extras ?? {}) as TelegramWebhookExtras) };
    delete extras.registeredUrl;
    await writeWebhookConfig(input.integrationId, input.serviceId, {
      ...current,
      extras: { ...extras } as Record<string, unknown>,
    });
  }
}
