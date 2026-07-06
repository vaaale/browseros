import "server-only";
import { IntegrationAuthError, IntegrationError } from "../../errors";
import { applyRetryAfter, waitIfBlocked } from "./rate-limiter";

// Thin fetch wrapper for the Telegram Bot API. Handles:
//   - Base URL construction (https://api.telegram.org/bot<token>/<method>).
//   - Request-level backoff via the in-process rate limiter (429 retry_after).
//   - Response validation (Telegram uses `{ ok: bool, result?, description?,
//     error_code?, parameters? }` for every method — non-2xx AND ok===false
//     both indicate an error).
//   - Retry loop for transient 5xx and 429 responses (max 3 attempts).
//
// Adapters call `telegramFetch(token, method, body)` for JSON payloads and
// `telegramFetchMultipart(token, method, form)` for file uploads.

const BASE = "https://api.telegram.org";
const MAX_ATTEMPTS = 3;

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

function apiUrl(token: string, method: string): string {
  return `${BASE}/bot${encodeURIComponent(token)}/${encodeURIComponent(method)}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function toIntegrationError(res: TelegramApiResponse<unknown>, method: string): IntegrationError {
  const desc = res.description ?? "Telegram API error";
  const code = res.error_code ?? 0;
  // Common: 401 Unauthorized ⇒ token revoked. Surface as auth error so the UI
  // can prompt for reconnect.
  if (code === 401) {
    return new IntegrationAuthError(`${method}: ${desc}`, { integrationId: "telegram" });
  }
  return new IntegrationError(`telegram_api_error_${code}`, `${method}: ${desc}`, {
    integrationId: "telegram",
  });
}

async function parseResponse<T>(res: Response, method: string): Promise<TelegramApiResponse<T>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as TelegramApiResponse<T>;
  } catch {
    throw new IntegrationError(
      "telegram_bad_response",
      `${method}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
      { integrationId: "telegram" },
    );
  }
}

/**
 * Call a Telegram Bot API method with a JSON body. Returns the parsed
 * `result` on success; throws an `IntegrationError` (or subclass) on failure.
 *
 * The rate-limiter is consulted BEFORE the request (so callers respect an
 * existing retry_after window) AND after any 429 response (so future callers
 * see the new window).
 */
export async function telegramFetch<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await waitIfBlocked(token);
    const res = await fetch(apiUrl(token, method), {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed = await parseResponse<T>(res, method);
    if (parsed.ok && parsed.result !== undefined) return parsed.result;
    if (parsed.ok) return undefined as unknown as T;
    // Handle 429 retry_after.
    const retryAfter = parsed.parameters?.retry_after;
    if (typeof retryAfter === "number" && retryAfter > 0) {
      applyRetryAfter(token, retryAfter);
      // Loop back to wait; unless this is our final attempt.
      if (attempt + 1 < MAX_ATTEMPTS) continue;
    }
    // Transient 5xx: brief backoff and retry.
    if (res.status >= 500 && res.status < 600 && attempt + 1 < MAX_ATTEMPTS) {
      await sleep(250 * 2 ** attempt);
      continue;
    }
    throw toIntegrationError(parsed, method);
  }
  throw new IntegrationError("telegram_max_attempts", `${method}: exhausted retries`, {
    integrationId: "telegram",
  });
}

/**
 * Call a Telegram Bot API method with a multipart/form-data body. Used for
 * `sendPhoto` / `sendDocument` uploads. The caller passes a `FormData`
 * containing `chat_id`, the file field (`photo`/`document`/…), and any
 * captions/parse_mode fields. Rate-limit + retry semantics match
 * {@link telegramFetch}.
 */
export async function telegramFetchMultipart<T>(
  token: string,
  method: string,
  form: FormData,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await waitIfBlocked(token);
    const res = await fetch(apiUrl(token, method), {
      method: "POST",
      body: form,
    });
    const parsed = await parseResponse<T>(res, method);
    if (parsed.ok && parsed.result !== undefined) return parsed.result;
    if (parsed.ok) return undefined as unknown as T;
    const retryAfter = parsed.parameters?.retry_after;
    if (typeof retryAfter === "number" && retryAfter > 0) {
      applyRetryAfter(token, retryAfter);
      if (attempt + 1 < MAX_ATTEMPTS) continue;
    }
    if (res.status >= 500 && res.status < 600 && attempt + 1 < MAX_ATTEMPTS) {
      await sleep(250 * 2 ** attempt);
      continue;
    }
    throw toIntegrationError(parsed, method);
  }
  throw new IntegrationError("telegram_max_attempts", `${method}: exhausted retries`, {
    integrationId: "telegram",
  });
}
