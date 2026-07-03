import "server-only";
import type { ServiceAdapter } from "../../adapters/base";

// Thin fetch wrapper for Google APIs. Applies exponential backoff (max 3
// attempts) on 429/5xx and delegates auth + 401-retry to the adapter's
// `authedFetch`. Adapters call this via a bound reference.

const MAX_ATTEMPTS = 3;

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Fetch a Google API endpoint with the adapter's authed fetch, retrying on
 * transient failures. Returns the parsed JSON body on success; throws with
 * the response body message on 4xx (non-429) and after retries on 5xx/429.
 */
export async function gsuiteFetch<T>(
  adapter: ServiceAdapter,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await adapter.authedFetch(url, init);
    if (res.ok) {
      // 204 → return undefined-cast; otherwise parse JSON.
      if (res.status === 204) return undefined as unknown as T;
      return (await res.json()) as T;
    }
    const shouldRetry = res.status === 429 || (res.status >= 500 && res.status < 600);
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      // ignore
    }
    if (!shouldRetry) {
      throw new Error(`Google API ${res.status}: ${bodyText || res.statusText}`);
    }
    lastErr = new Error(`Google API ${res.status}: ${bodyText || res.statusText}`);
    // Exponential backoff: 250ms, 500ms, 1000ms.
    await sleep(250 * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error("Google API request failed");
}
