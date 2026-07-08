import "server-only";
import type { NextRequest } from "next/server";
import type { WebhookHandler } from "../../../webhooks/handler";
import type { WebhookConfig, WebhookReceiveResult, WebhookSecrets } from "../../../webhooks/types";
import { GmailAdapter } from "./gmail";

// Gmail push handler.
//
// Verification: Google Pub/Sub push subscriptions authenticate to the
// receiver by attaching a Google-signed OIDC ID token in the `Authorization`
// header (`Bearer <jwt>`). We validate that JWT via Google's tokeninfo
// endpoint — zero extra deps, one network hop per webhook.
//
// The tokeninfo endpoint returns the decoded token when valid; we check:
//   - `iss` is `https://accounts.google.com` or `accounts.google.com`
//   - `aud` matches the audience we requested when creating the subscription
//     (stored in `WebhookConfig.extras.audience`; the audience is set by the
//     user in GCP when they configure the push subscription).
//   - `email` (optional) matches the configured service account, if the user
//     set `extras.pushServiceAccount`.
//
// Payload: Google Pub/Sub push messages have the shape
//   {
//     message: { data: <base64>, messageId, publishTime, attributes? },
//     subscription: "projects/<id>/subscriptions/<name>"
//   }
// For Gmail, `data` is base64 of `{ emailAddress, historyId }`. We translate
// each push into a synthetic `new_email_history` event carrying the
// historyId; the scheduler / caller can then diff against the last known
// history via gmail.users.history.list.

interface PushEnvelope {
  message: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

interface GmailHistoryPayload {
  emailAddress?: string;
  historyId?: string;
}

interface GmailWebhookExtras {
  /**
   * Full Pub/Sub topic path (`projects/<id>/topics/<name>`). Required for
   * `onEnable` to call gmail.users.watch. Set from the Settings UI.
   */
  topicName?: string;
  /**
   * Push subscription id / name (informational — for display + tear-down).
   */
  subscriptionId?: string;
  /**
   * `aud` claim we expect on inbound JWTs. Google embeds the value the user
   * set when they created the push subscription. If unset, we skip aud check
   * (permissive fallback, still requires signed google-issued token).
   */
  audience?: string;
  /**
   * Expected `email` claim (i.e. push service-account email). If set, the
   * receiver rejects tokens issued by other service accounts.
   */
  pushServiceAccount?: string;
  /**
   * Label id filter passed to `users.watch`. Default: `["INBOX"]`.
   */
  labelIds?: string[];
  /**
   * Cached `historyId` returned from the last `watch` call. Used as the
   * starting point for history diffs (Phase 3 will fill this in).
   */
  lastHistoryId?: string;
}

/** Verify a Google-signed OIDC token via the tokeninfo endpoint. */
async function verifyGoogleToken(
  bearer: string,
  expected: { audience?: string; serviceAccount?: string },
): Promise<boolean> {
  try {
    const url = new URL("https://oauth2.googleapis.com/tokeninfo");
    url.searchParams.set("id_token", bearer);
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return false;
    const claims = (await res.json()) as {
      iss?: string;
      aud?: string;
      email?: string;
      email_verified?: string | boolean;
      exp?: string | number;
    };
    const iss = claims.iss ?? "";
    if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") return false;
    if (expected.audience && claims.aud !== expected.audience) return false;
    if (expected.serviceAccount && claims.email !== expected.serviceAccount) return false;
    // Verified emails: Google's ID tokens include email_verified as boolean-ish.
    if (expected.serviceAccount) {
      const verified = claims.email_verified === true || claims.email_verified === "true";
      if (!verified) return false;
    }
    const exp = typeof claims.exp === "string" ? Number(claims.exp) : claims.exp;
    if (typeof exp === "number" && exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort base64 → utf-8 decode. Pub/Sub uses standard base64 (not URL-safe).
 */
function b64decode(input: string): string {
  try {
    return Buffer.from(input, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Call `gmail.users.watch` to bind Gmail to a Pub/Sub topic. Idempotent — a
 * new call resets the delivery. Returns the new historyId so the caller can
 * cache it for later diffing.
 */
async function callWatch(
  adapter: GmailAdapter,
  topicName: string,
  labelIds: string[] | undefined,
): Promise<{ historyId?: string; expiration?: string }> {
  const url = "https://gmail.googleapis.com/gmail/v1/users/me/watch";
  const body = JSON.stringify({
    topicName,
    labelIds: labelIds ?? ["INBOX"],
    labelFilterAction: "include",
  });
  const res = await adapter.authedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gmail.users.watch failed: ${res.status} ${text}`);
  }
  return (await res.json()) as { historyId?: string; expiration?: string };
}

/** Call `gmail.users.stop` to tear down push delivery. */
async function callStop(adapter: GmailAdapter): Promise<void> {
  const url = "https://gmail.googleapis.com/gmail/v1/users/me/stop";
  const res = await adapter.authedFetch(url, { method: "POST" });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`gmail.users.stop failed: ${res.status} ${text}`);
  }
}

export class GmailWebhookHandler implements WebhookHandler {
  async verify(input: {
    req: NextRequest;
    body: string;
    secrets: WebhookSecrets | null;
    config: WebhookConfig;
  }): Promise<boolean> {
    const auth = input.req.headers.get("authorization") ?? "";
    const match = auth.match(/^bearer\s+(.+)$/i);
    if (!match) return false;
    const extras = (input.config.extras ?? {}) as GmailWebhookExtras;
    return verifyGoogleToken(match[1], {
      audience: extras.audience,
      serviceAccount: extras.pushServiceAccount,
    });
  }

  async receive(input: {
    req: NextRequest;
    body: string;
    config: WebhookConfig;
  }): Promise<WebhookReceiveResult> {
    let env: PushEnvelope;
    try {
      env = JSON.parse(input.body) as PushEnvelope;
    } catch {
      return { events: [] };
    }
    if (!env?.message?.data) {
      // Empty push (Google's health check) — ack with 200 and no events.
      return { events: [] };
    }
    let payload: GmailHistoryPayload = {};
    try {
      payload = JSON.parse(b64decode(env.message.data)) as GmailHistoryPayload;
    } catch {
      // Malformed payload — ack anyway so Google doesn't retry forever.
      return { events: [] };
    }
    if (!payload.historyId) return { events: [] };
    return {
      events: [
        {
          type: "gmail_history",
          service: "gsuite/gmail",
          timestamp: env.message.publishTime ? Date.parse(env.message.publishTime) : Date.now(),
          data: {
            historyId: payload.historyId,
            emailAddress: payload.emailAddress,
            messageId: env.message.messageId,
            subscription: env.subscription,
          },
        },
      ],
    };
  }

  async onEnable(input: {
    integrationId: string;
    serviceId: string;
    config: WebhookConfig;
  }): Promise<void> {
    const extras = (input.config.extras ?? {}) as GmailWebhookExtras;
    if (!extras.topicName) {
      throw new Error(
        "Gmail webhook requires `extras.topicName` (GCP Pub/Sub topic). Configure it in Settings → Integrations → GSuite → Gmail → Webhook.",
      );
    }
    const adapter = new GmailAdapter();
    const res = await callWatch(adapter, extras.topicName, extras.labelIds);
    if (res.historyId) {
      // Cache the historyId back into the config so a future push can be diffed.
      const { writeWebhookConfig } = await import("../../../webhooks/store");
      await writeWebhookConfig(input.integrationId, input.serviceId, {
        ...input.config,
        extras: { ...extras, lastHistoryId: res.historyId },
      });
    }
  }

  async onDisable(input: { integrationId: string; serviceId: string }): Promise<void> {
    const adapter = new GmailAdapter();
    await callStop(adapter);
  }
}
