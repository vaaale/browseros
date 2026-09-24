// Reproduction: TelegramBotWebhookHandler.onEnable ignored setWebhook's result.
//
// Telegram's setWebhook responds `{ ok: true, result: false }` when it accepts
// the request but refuses to register the URL (e.g. unreachable host, bad
// certificate). The offending code in
// src/lib/integrations/services/telegram/adapters/bot-webhook.ts was:
//
//   await telegramFetch<boolean>(token, "setWebhook", body);   // result dropped
//
// so a refused registration resolved successfully, persisted `registeredUrl`,
// and the user saw a "working" webhook that Telegram never delivers to.
// Expected behaviour: on `result === false`, fetch getWebhookInfo for the
// provider-side error description and throw an IntegrationError carrying it.
//
// Run: npm run test:unit -- tests/integrations/telegram-webhook-onenable.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { _resetKeyCache } from "../../src/lib/integrations/secrets/keyfile";
import { getSecretsStore } from "../../src/lib/integrations/secrets/store";
import { IntegrationError } from "../../src/lib/integrations/errors";
import { TelegramBotWebhookHandler } from "../../src/lib/integrations/services/telegram/adapters/bot-webhook";
import { readWebhookConfig } from "../../src/lib/integrations/webhooks/store";

const BOT_TOKEN = "12345:TEST_TOKEN_abcdefghijklmnopqrst";

/** Stub global fetch with canned Telegram Bot API responses, keyed by method
 *  name (the last path segment of https://api.telegram.org/bot<token>/<method>).
 *  No request leaves the process — the unit suite is hermetic. */
function stubTelegramApi(responses: Record<string, unknown>): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    calls.push(method);
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
  const { cleanup } = useTestDataDir(label);
  _resetKeyCache();
  return () => {
    _resetKeyCache();
    cleanup();
  };
}

test.describe("Telegram bot webhook onEnable", () => {
  test("throws an IntegrationError with Telegram's description when setWebhook returns false", async () => {
    const dispose = setup("tg-webhook-refused");
    const api = stubTelegramApi({
      setWebhook: { ok: true, result: false },
      getWebhookInfo: {
        ok: true,
        result: {
          url: "",
          has_custom_certificate: false,
          pending_update_count: 0,
          last_error_message: "SSL error: certificate verify failed",
        },
      },
    });
    try {
      await getSecretsStore().set("telegram", "bot_token", { token: BOT_TOKEN });
      const handler = new TelegramBotWebhookHandler();
      const enable = handler.onEnable({
        integrationId: "telegram",
        serviceId: "bot",
        config: { enabled: true },
        origin: "https://bos.example.com",
      });
      await expect(enable).rejects.toThrow(IntegrationError);
      await expect(enable).rejects.toThrow(/SSL error: certificate verify failed/);
      expect(api.calls).toContain("getWebhookInfo");
      // A refused registration must not be persisted as a registered URL.
      const cfg = await readWebhookConfig("telegram", "bot");
      const extras = (cfg?.extras ?? {}) as { registeredUrl?: string };
      expect(extras.registeredUrl).toBeUndefined();
    } finally {
      api.restore();
      dispose();
    }
  });

  test("still registers and persists the URL when setWebhook succeeds", async () => {
    const dispose = setup("tg-webhook-ok");
    const api = stubTelegramApi({
      setWebhook: { ok: true, result: true, description: "Webhook was set" },
    });
    try {
      await getSecretsStore().set("telegram", "bot_token", { token: BOT_TOKEN });
      const handler = new TelegramBotWebhookHandler();
      await handler.onEnable({
        integrationId: "telegram",
        serviceId: "bot",
        config: { enabled: true },
        origin: "https://bos.example.com",
      });
      expect(api.calls).toEqual(["setWebhook"]);
      const cfg = await readWebhookConfig("telegram", "bot");
      const extras = (cfg?.extras ?? {}) as { registeredUrl?: string };
      expect(extras.registeredUrl).toBe("https://bos.example.com/api/integrations/webhooks/telegram/bot");
    } finally {
      api.restore();
      dispose();
    }
  });
});
