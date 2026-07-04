// Unit tests for DriveAdapter — uses the mock-fetch harness. No test runner
// is wired into package.json (see plan.md D7); these tests are structured as
// callable async functions and export a `runAll()` entry so they can be
// executed from an ad-hoc node script or, when Vitest/similar ships, wrapped
// in `describe`/`it` with a one-line adapter.
//
// The tests bypass `ServiceAdapter.authedFetch` (which requires a real OAuth
// token) by subclassing `DriveAdapter` and overriding just the auth layer.
// The scope + state layer is stubbed with an override on `getEffectiveScopes`.

import { DriveAdapter } from "../services/gsuite/adapters/drive";
import { DRIVE_SCOPES } from "../services/gsuite/manifest";
import { IntegrationScopeError } from "../errors";
import {
  install,
  restore,
  getCalls,
  jsonResponse,
  binaryResponse,
} from "./mock-fetch";

// --- Test harness ---------------------------------------------------------

/**
 * Test subclass that bypasses the OAuth-manager path in `authedFetch` (so we
 * don't need a real token / SecretsStore in tests) and lets us stub the
 * effective-scope set per test.
 */
class TestDriveAdapter extends DriveAdapter {
  private effective: Set<string> = new Set([DRIVE_SCOPES.readonly]);

  override async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: "Bearer test-token" },
    });
  }

  /**
   * Overrides the private-ish getEffectiveScopes on ServiceAdapter. We do this
   * via the same method name to shadow the base impl — TypeScript's `protected`
   * access is enforced at the class boundary, and subclasses can widen.
   */
  setEffectiveScopes(scopes: Iterable<string>): void {
    this.effective = new Set(scopes);
  }

  protected override async getEffectiveScopes(): Promise<Set<string>> {
    return this.effective;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// --- Tests ----------------------------------------------------------------

/**
 * Test 1 — `listFiles` builds the correct query string. Verifies the params
 * end up as the expected `?q=…&pageSize=…&…` on the request URL.
 */
export async function testListFilesBuildsQuery(): Promise<void> {
  install({
    routes: {},
    defaultHandler: () =>
      jsonResponse({ files: [{ id: "1", name: "a", mimeType: "text/plain" }], nextPageToken: "tok" }),
  });
  try {
    const adapter = new TestDriveAdapter();
    const result = await adapter.listFiles({ q: "name contains 'foo'", pageSize: 25 });
    assert(result.files.length === 1, "expected one file returned");
    assert(result.nextPageToken === "tok", "expected pageToken forwarded");
    const call = getCalls()[0];
    assert(call.url.includes("q=name+contains"), "query 'q' should be url-encoded in the URL");
    assert(call.url.includes("pageSize=25"), "pageSize should appear on the URL");
    assert(
      call.url.includes("supportsAllDrives=true"),
      "supportsAllDrives should be added by DriveAdapter",
    );
  } finally {
    restore();
  }
}

/**
 * Test 2 — `downloadFile` base64-encodes the mocked binary body.
 */
export async function testDownloadFileBase64(): Promise<void> {
  const payload = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
  install({
    routes: {
      // getFile metadata peek (size lookup)
      "GET https://www.googleapis.com/drive/v3/files/abc?fields=size%2CmimeType&supportsAllDrives=true": () =>
        jsonResponse({ size: String(payload.byteLength), mimeType: "text/plain" }),
      // alt=media binary
      "GET https://www.googleapis.com/drive/v3/files/abc?alt=media&supportsAllDrives=true": () =>
        binaryResponse(payload, "text/plain"),
    },
  });
  try {
    const adapter = new TestDriveAdapter();
    const result = await adapter.downloadFile({ id: "abc", maxBytes: 1024 });
    assert("base64" in result, "expected a base64 result (not too_large)");
    if ("base64" in result) {
      assert(result.base64 === "SGVsbG8=", `expected base64 SGVsbG8= got ${result.base64}`);
      assert(result.size === 5, "size should reflect the raw byte length");
      assert(result.contentType === "text/plain", "content-type should be forwarded");
    }
  } finally {
    restore();
  }
}

/**
 * Test 3 — `exportFile` sends the `mimeType` query param.
 */
export async function testExportFilePassesMimeType(): Promise<void> {
  install({
    routes: {},
    defaultHandler: () => binaryResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf"),
  });
  try {
    const adapter = new TestDriveAdapter();
    const result = await adapter.exportFile({ id: "doc-1", mimeType: "application/pdf", maxBytes: 4096 });
    const call = getCalls()[0];
    assert(call.url.includes("/files/doc-1/export"), "URL should hit /export");
    assert(call.url.includes("mimeType=application%2Fpdf"), "mimeType should be url-encoded on the URL");
    assert("base64" in result, "expected base64 result");
  } finally {
    restore();
  }
}

/**
 * Test 4 — With `drive.readonly` disabled, `listFiles` throws
 * `IntegrationScopeError` and never hits fetch.
 */
export async function testScopeDisabledThrows(): Promise<void> {
  install({ routes: {}, defaultHandler: () => jsonResponse({}) });
  try {
    const adapter = new TestDriveAdapter();
    adapter.setEffectiveScopes([]); // no scopes granted
    let threw = false;
    try {
      await adapter.listFiles({});
    } catch (err) {
      threw = err instanceof IntegrationScopeError;
    }
    assert(threw, "listFiles should throw IntegrationScopeError when drive.readonly missing");
    assert(getCalls().length === 0, "no fetch call should be made when scope check fails");
  } finally {
    restore();
  }
}

// --- Entry ---------------------------------------------------------------

export async function runAll(): Promise<void> {
  await testListFilesBuildsQuery();
  await testDownloadFileBase64();
  await testExportFilePassesMimeType();
  await testScopeDisabledThrows();
}
