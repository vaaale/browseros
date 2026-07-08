// Lightweight mock-fetch harness for adapter unit tests. Framework-free — no
// test-runner dependency; can be driven from a plain `node --input-type=module`
// invocation or wrapped by Vitest/Jest later without touching this file.
//
// Usage:
//   install({
//     "GET https://gmail.googleapis.com/gmail/v1/users/me/labels": () =>
//       new Response(JSON.stringify({ labels: [] }), { status: 200 }),
//   });
//   // ... run adapter code that calls fetch ...
//   const calls = getCalls();
//   restore();
//
// Handler keys use the form `<METHOD> <URL>` (method defaults to GET). If no
// exact match is found and a `default` handler is provided, that runs;
// otherwise `install` throws to surface a missing mock in tests early.

export type MockHandler = (init: RequestInit, url: string) => Response | Promise<Response>;

export interface MockCall {
  method: string;
  url: string;
  init: RequestInit;
  timestamp: number;
}

let originalFetch: typeof globalThis.fetch | undefined;
let installed = false;
const calls: MockCall[] = [];

export interface InstallOptions {
  routes: Record<string, MockHandler>;
  defaultHandler?: MockHandler;
}

/**
 * Swap `globalThis.fetch` with a mock that dispatches based on `<METHOD> <URL>`.
 * Records every call. Throws on install-time if already installed.
 */
export function install(opts: InstallOptions): void {
  if (installed) throw new Error("mock-fetch already installed — call restore() first");
  originalFetch = globalThis.fetch;
  installed = true;
  calls.length = 0;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    calls.push({ method, url, init, timestamp: Date.now() });

    const handler = opts.routes[key] ?? opts.routes[url] ?? opts.defaultHandler;
    if (!handler) {
      throw new Error(`mock-fetch: no handler for ${key}`);
    }
    return handler(init, url);
  }) as typeof globalThis.fetch;
}

export function restore(): void {
  if (!installed) return;
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  installed = false;
  calls.length = 0;
}

export function getCalls(): readonly MockCall[] {
  return calls;
}

/** Return the first call whose URL matches (substring test). */
export function findCall(urlSubstr: string): MockCall | undefined {
  return calls.find((c) => c.url.includes(urlSubstr));
}

// --- Response builders ---------------------------------------------------

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function binaryResponse(bytes: Uint8Array | ArrayBuffer, contentType = "application/octet-stream", status = 200): Response {
  const body: ArrayBuffer = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

export function errorResponse(status: number, message = "error"): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
