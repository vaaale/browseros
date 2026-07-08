// Framework-free webhook types. Safe to import from client OR server.

import type { IntegrationEvent } from "../types";

/** Persisted per-service webhook config. Stored in `state.services[svcId].config.webhook`. */
export interface WebhookConfig {
  /** User-visible on/off. When false the receiver 404s. */
  enabled: boolean;
  /**
   * Which event types the caller is interested in. Empty ⇒ all events pass.
   * Interpreted by the handler; the framework does not filter for you.
   */
  eventTypes?: string[];
  /**
   * Service-specific configuration (e.g. Gmail Pub/Sub topic/subscription).
   * Left permissive so we don't need a schema per service.
   */
  extras?: Record<string, unknown>;
}

/**
 * A generic webhook secret persisted in `SecretsStore` under
 * `webhook:<serviceId>`. Ring-buffer of recent signing secrets so we can
 * rotate without a hard cut-over.
 */
export interface WebhookSecrets {
  /** The primary secret (used for signing outgoing verification headers, and preferred on inbound). */
  primary: string;
  /** Optional previous secret still accepted for verification (rotation grace). */
  previous?: string;
  /** Epoch-ms when `primary` was last rotated. */
  rotatedAt: number;
}

/**
 * Result of a handler receiving a webhook. `events` are appended to the
 * notifications store by the framework; the handler focuses on parsing +
 * validation only.
 */
export interface WebhookReceiveResult {
  events: IntegrationEvent[];
  /**
   * Opaque acknowledgement returned to the provider. If set, the receiver
   * responds with this exact JSON body; otherwise `{ ok: true }`.
   */
  ack?: Record<string, unknown>;
}
