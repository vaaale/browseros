// Reproduction: the Telegram webhook could not traverse a Bastion-fronted
// deployment, and its receiver-side verification ignored the framework secret.
//
// Two coupled defects in
// src/lib/integrations/services/telegram/adapters/bot-webhook.ts:
//
//  1. onEnable only sent `secret_token` to Telegram when the user had typed
//     one into `extras.secretToken` — it ignored the WebhookSecrets.primary
//     the framework mints in enableWebhook() right before calling it. With no
//     secret registered, Telegram's deliveries carry no
//     X-Telegram-Bot-Api-Secret-Token header at all, so Bastion (which routes
//     credential-less traffic by resolving a presented secret against each
//     user's data/system/credentials-index.json — 034-secrets-authentication)
//     had nothing to route by and 401'd every delivery at the gateway.
//  2. Even with a secret, nothing wrote the credentials-index entry Bastion's
//     resolveCredential() scans, so the delivery still could not be routed.
//
// Expected behaviour: enabling the webhook always registers a secret_token
// with Telegram (extras.secretToken if the user set one, else the minted
// WebhookSecrets.primary), records sha256(secret) → "telegram-webhook" in the
// credentials index, and verify() accepts exactly that secret; disabling
// removes the index entry.
//
// Run: npm run test:unit -- tests/integrations/telegram-webhook-secret.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { useTestDataDir } from "../services/_test-env";
import { _resetKeyCache } from "../../src/lib/integrations/secrets/keyfile";
import { getSecretsStore } from "../../src/lib/integrations/secrets/store";
import { mutateState } from "../../src/lib/integrations/state/store";
import { enableWebhook, disableWebhook } from "../../src/lib/integrations/webhooks/manager";
import { readWebhookSecrets } from "../../src/lib/integrations/webhooks/store";
import { _resetDeliveryRing } from "../../src/lib/integrations/webhooks/verify";
import { POST } from "../../src/app/api/integrations/webhooks/[integrationId]/[serviceId]/route";

const BOT_TOKEN = "12345:TEST_TOKEN_abcdefghijklmnopqrst";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stub global fetch with canned Telegram Bot API responses, keyed by method
 *  name. Captures each call's parsed JSON body so tests can assert exactly
 *  what was sent. No request leaves the process — the unit suite is hermetic. */
function stubTelegramApi(responses: Record<string, unknown>): {
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  restore: () => void;
} {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });
    const payload = responses[method];
    if (payload === undefined) throw new Error(`unexpected Telegram method: ${method}`);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function setup(label: string) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useTestDataDir is a test helper (temp-dir setup), not a React hook
  const { dir, cleanup } = useTestDataDir(label);
  _resetKeyCache();
  _resetDeliveryRing();
  return {
    dir,
    dispose: () => {
      _resetKeyCache();
      _resetDeliveryRing();
      cleanup();
    },
  };
}

async function readCredentialsIndex(dataDir: string): Promise<Record<string, { service: string }>> {
  try {
    const raw = await fs.readFile(path.join(dataDir, "system", "credentials-index.json"), "utf8");
    return (JSON.parse(raw) as { entries: Record<string, { service: string }> }).entries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Connect the bot: token in the secrets store + connected flag in state —
 *  the two preconditions the enable flow and the receiver route check. */
async function connectBot(): Promise<void> {
  await getSecretsStore().set("telegram", "bot_token", { token: BOT_TOKEN });
  await mutateState("telegram", (prev) => ({ ...prev, connected: true }));
}

async function enable(): Promise<string> {
  await enableWebhook({
    integrationId: "telegram",
    serviceId: "bot",
    origin: "https://bos.example.com",
  });
  const secrets = await readWebhookSecrets("telegram", "bot");
  expect(secrets?.primary).toBeTruthy();
  return secrets!.primary;
}

/** Minimal NextRequest stand-in for the receiver route: headers.get + text(). */
function makeWebhookReq(body: string, headers: Record<string, string>): NextRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as NextRequest;
}

function postToReceiver(body: string, headers: Record<string, string>) {
  return POST(makeWebhookReq(body, headers), {
    params: Promise.resolve({ integrationId: "telegram", serviceId: "bot" }),
  });
}

test.describe("Telegram bot webhook — secret registration and routing index", () => {
  test("enableWebhook registers the minted framework secret with Telegram and indexes it for Bastion routing", async () => {
    const { dir, dispose } = setup("tg-webhook-secret-enable");
    const api = stubTelegramApi({
      setWebhook: { ok: true, result: true, description: "Webhook was set" },
    });
    try {
      await connectBot();
      const primary = await enable();

      // The registration Telegram received must carry the minted secret —
      // this is what makes Telegram echo X-Telegram-Bot-Api-Secret-Token on
      // every delivery, which is the only thing Bastion can route by.
      const setWebhookCall = api.calls.find((c) => c.method === "setWebhook");
      expect(setWebhookCall?.body.secret_token).toBe(primary);

      // And the Bastion routing companion index must know the secret.
      const entries = await readCredentialsIndex(dir);
      expect(entries[sha256(primary)]?.service).toBe("telegram-webhook");
    } finally {
      api.restore();
      dispose();
    }
  });

  test("a user-supplied extras.secretToken wins over the minted secret and is what gets indexed", async () => {
    const { dir, dispose } = setup("tg-webhook-secret-user");
    const api = stubTelegramApi({
      setWebhook: { ok: true, result: true },
    });
    try {
      await connectBot();
      await enableWebhook({
        integrationId: "telegram",
        serviceId: "bot",
        origin: "https://bos.example.com",
        patch: { extras: { secretToken: "user-chosen-token_123" } },
      });

      const setWebhookCall = api.calls.find((c) => c.method === "setWebhook");
      expect(setWebhookCall?.body.secret_token).toBe("user-chosen-token_123");

      const entries = await readCredentialsIndex(dir);
      expect(entries[sha256("user-chosen-token_123")]?.service).toBe("telegram-webhook");
    } finally {
      api.restore();
      dispose();
    }
  });

  test("disableWebhook removes the routing index entry", async () => {
    const { dir, dispose } = setup("tg-webhook-secret-disable");
    const api = stubTelegramApi({
      setWebhook: { ok: true, result: true },
      deleteWebhook: { ok: true, result: true },
    });
    try {
      await connectBot();
      const primary = await enable();
      expect((await readCredentialsIndex(dir))[sha256(primary)]).toBeTruthy();

      await disableWebhook({ integrationId: "telegram", serviceId: "bot" });
      expect((await readCredentialsIndex(dir))[sha256(primary)]).toBeUndefined();
    } finally {
      api.restore();
      dispose();
    }
  });
});

test.describe("Telegram bot webhook — receiver verification (simulated Telegram POST)", () => {
  const update = (id: number) =>
    JSON.stringify({
      update_id: id,
      message: {
        message_id: 7,
        date: 1758240000,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Test" },
        text: "hello from telegram",
      },
    });

  test("a POST carrying the registered secret token is accepted end-to-end through the route handler", async () => {
    const { dispose } = setup("tg-webhook-recv-ok");
    const api = stubTelegramApi({
      setWebhook: { ok: true, result: true },
    });
    try {
      await connectBot();
      const primary = await enable();

      const res = await postToReceiver(update(1001), {
        "x-telegram-bot-api-secret-token": primary,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);
    } finally {
      api.restore();
      dispose();
    }
  });

  test("a POST with a wrong or missing secret token is rejected 401 by the route handler", async () => {
    const { dispose } = setup("tg-webhook-recv-bad");
    const api = stubTelegramApi({
      setWebhook: { ok: true, result: true },
    });
    try {
      await connectBot();
      await enable();

      const wrong = await postToReceiver(update(2001), {
        "x-telegram-bot-api-secret-token": "not-the-registered-secret",
      });
      expect(wrong.status).toBe(401);

      const missing = await postToReceiver(update(2002), {});
      expect(missing.status).toBe(401);
    } finally {
      api.restore();
      dispose();
    }
  });
});
