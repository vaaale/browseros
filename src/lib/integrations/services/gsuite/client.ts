import "server-only";
import type { ServiceAdapter } from "../../adapters/base";
import { IntegrationConfigError } from "../../errors";

// Thin fetch wrappers for Google APIs. Applies exponential backoff (max 3
// attempts) on 429/5xx and delegates auth + 401-retry to the adapter's
// `authedFetch`. Adapters call these via a bound reference.

const MAX_ATTEMPTS = 3;

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function attemptWithRetry(
  adapter: ServiceAdapter,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await adapter.authedFetch(url, init);
    if (res.ok) return res;
    const shouldRetry = res.status === 429 || (res.status >= 500 && res.status < 600);
    let bodyText = "";
    try {
      bodyText = await res.clone().text();
    } catch {
      // ignore body-read errors
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

/**
 * Fetch a Google API JSON endpoint with the adapter's authed fetch, retrying
 * on transient failures. Returns the parsed JSON body on success; throws with
 * the response body message on 4xx (non-429) and after retries on 5xx/429.
 */
export async function gsuiteFetch<T>(
  adapter: ServiceAdapter,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await attemptWithRetry(adapter, url, init);
  // 204 → return undefined-cast; otherwise parse JSON.
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface GsuiteBinaryResponse {
  contentType: string;
  buffer: ArrayBuffer;
}

/**
 * Binary sibling of {@link gsuiteFetch} — for Drive `alt=media` downloads and
 * Docs exports. Same retry contract; caller converts the buffer to base64 or
 * writes it to disk / VFS. Returns an ArrayBuffer (framework-free type) so a
 * client-side caller could theoretically consume the same shape.
 */
export async function gsuiteFetchBinary(
  adapter: ServiceAdapter,
  url: string,
  init: RequestInit = {},
): Promise<GsuiteBinaryResponse> {
  const res = await attemptWithRetry(adapter, url, init);
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = await res.arrayBuffer();
  return { contentType, buffer };
}

/**
 * Compose a URL from base + path + optional query object. Drops
 * undefined/null/empty-string values; array values append repeated keys
 * (matching Google API's `labelIds=A&labelIds=B` convention). Empty query
 * yields no trailing `?`.
 */
export function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | boolean | string[] | undefined | null>,
): string {
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${cleanBase}${cleanPath}`;
  if (!query) return url;
  const params = new URLSearchParams();
  let count = 0;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === undefined || v === null || v === "") continue;
        params.append(key, String(v));
        count++;
      }
    } else {
      params.append(key, String(value));
      count++;
    }
  }
  return count === 0 ? url : `${url}?${params.toString()}`;
}

export interface MultipartUploadInput {
  metadata: Record<string, unknown>;
  media: ArrayBuffer | Uint8Array | string;
  mediaMimeType: string;
}

/**
 * Placeholder for multipart Drive/Photos uploads. Phase 3 does not implement
 * write operations — this stub exists so future write methods can be declared
 * with the intended signature. Real implementation would build a
 * `multipart/related` body with the metadata JSON part + the media part and
 * POST to Google's upload endpoints.
 *
 * @throws IntegrationConfigError with code `multipart_upload_not_yet_implemented`.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
export async function gsuiteMultipartUpload(
  _adapter: ServiceAdapter,
  _url: string,
  _input: MultipartUploadInput,
): Promise<never> {
  throw new IntegrationConfigError(
    "Multipart upload is not yet implemented (Phase 4).",
    { integrationId: "gsuite" },
  );
}
/* eslint-enable @typescript-eslint/no-unused-vars */
