import "server-only";
import type { NextRequest } from "next/server";
import type { WebhookReceiveResult, WebhookSecrets, WebhookConfig } from "./types";

// Interface every service-specific webhook handler implements.
//
// The framework (webhooks route) takes care of:
//   - Looking up the config + secrets for (integrationId, serviceId).
//   - Reading the raw body (for signature verification).
//   - Feeding events returned by `receive()` to the notifications store.
//   - Idempotency (a shared ring buffer keyed on the provider's messageId).
//
// The handler is responsible for:
//   - `verify(req, body, secrets, config)`: return true iff the request is
//     authentic. Handlers may use `verifySignature` from `./verify.ts` (default
//     HMAC scheme) or a custom scheme (Gmail JWT).
//   - `receive(req, body, config)`: parse the payload and return a list of
//     `IntegrationEvent`s to emit + an optional custom ack body.
//
// Handlers must be pure with respect to request state (they may hit
// SecretsStore or state.json for context, but shouldn't stash cross-request
// state). One handler instance is created per registered service and reused.

export interface WebhookHandler {
  /**
   * Return true iff the request is authentic. Called after the framework
   * confirms the service is enabled + a config exists. Handlers should NOT
   * modify state here — this is a pure predicate.
   */
  verify(input: {
    req: NextRequest;
    body: string;
    secrets: WebhookSecrets | null;
    config: WebhookConfig;
  }): Promise<boolean>;

  /**
   * Parse the payload and return events. Called only after `verify` returns
   * true and the idempotency check passes. Handlers may throw — the receiver
   * turns exceptions into 500s.
   */
  receive(input: {
    req: NextRequest;
    body: string;
    config: WebhookConfig;
  }): Promise<WebhookReceiveResult>;

  /**
   * Optional lifecycle hook called by the WebhookManager when the user
   * enables (or re-enables) the webhook. Handlers can use this to register
   * with the provider (e.g. call gmail.users.watch). Idempotent.
   */
  onEnable?(input: { integrationId: string; serviceId: string; config: WebhookConfig }): Promise<void>;

  /**
   * Optional lifecycle hook called on disable / delete. Handlers can use this
   * to tear down the provider subscription (e.g. gmail.users.stop).
   */
  onDisable?(input: { integrationId: string; serviceId: string }): Promise<void>;
}
