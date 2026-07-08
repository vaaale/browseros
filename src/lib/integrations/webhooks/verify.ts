import "server-only";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// Shared verification helpers used by the default webhook handler.
//
// Signature scheme (default):
//   HMAC-SHA256 over the raw request body, using a shared secret. Header:
//     `X-BOS-Signature: sha256=<hex>`
//   Optional `X-BOS-Timestamp` (epoch-ms as string) is included in the signed
//   payload as `${timestamp}.${body}` when both sides opt in. Timestamp guards
//   against replay when the caller sets it; the default handler leaves it off.
//
// Handlers that use a non-HMAC scheme (e.g. Gmail's JWT bearer) bypass this
// module entirely and implement their own `verify`.

/** Generate a hex-encoded secret suitable for HMAC signing. 32 bytes = 256 bits. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compute the canonical signature header for a payload. Callers that want to
 * SIGN a webhook (e.g. tests, or a "Send test webhook" button) can use this
 * to produce the exact value the receiver expects.
 */
export function signPayload(secret: string, body: string, timestamp?: number): string {
  const mac = createHmac("sha256", secret);
  const signedText = timestamp !== undefined ? `${timestamp}.${body}` : body;
  mac.update(signedText, "utf8");
  return `sha256=${mac.digest("hex")}`;
}

/**
 * Verify a signature header against the raw body + a set of candidate secrets
 * (typically `[primary, previous]` so rotation has a grace window).
 *
 * Returns true iff any candidate matches. Uses `timingSafeEqual` to avoid
 * leaking match position through timing.
 */
export function verifySignature(
  secrets: string[],
  header: string | null | undefined,
  body: string,
  timestamp?: number,
): boolean {
  if (!header) return false;
  const provided = header.trim();
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = signPayload(secret, body, timestamp);
    // timingSafeEqual requires equal-length buffers.
    if (provided.length !== expected.length) continue;
    try {
      if (timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"))) {
        return true;
      }
    } catch {
      // Length mismatch or other buffer error — treat as no match.
    }
  }
  return false;
}

// --- Idempotency ring buffer ---------------------------------------------
//
// A tiny in-memory LRU-ish ring of recent payload hashes. If the provider
// re-delivers the same webhook (Google Pub/Sub retries aggressively), the
// receiver skips reprocessing.

const RING_SIZE = 1000;

interface Ring {
  set: Set<string>;
  queue: string[];
}

const ring: Ring = { set: new Set(), queue: [] };

/**
 * Record a payload hash. Returns true if the hash was already present (⇒
 * caller should ack + skip); false if newly recorded (⇒ caller should process).
 */
export function markDelivery(hash: string): boolean {
  if (ring.set.has(hash)) return true;
  ring.set.add(hash);
  ring.queue.push(hash);
  if (ring.queue.length > RING_SIZE) {
    const drop = ring.queue.shift();
    if (drop !== undefined) ring.set.delete(drop);
  }
  return false;
}

/** Test-only: forget every remembered delivery. */
export function _resetDeliveryRing(): void {
  ring.set.clear();
  ring.queue.length = 0;
}

/** Compute a stable hash for use as an idempotency key. SHA-256 of the payload. */
export function hashPayload(...parts: (string | undefined)[]): string {
  const hash = createHmac("sha256", "bos-webhook-idempotency");
  for (const p of parts) {
    if (p !== undefined) hash.update(p, "utf8");
    hash.update("\x1f");
  }
  return hash.digest("hex");
}
