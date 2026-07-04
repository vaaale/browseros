// URL-builder test for the delta-scope OAuth flow (G4). Verifies that
// `OAuthManager.startFlow({ scopes: [...] })` produces an auth URL whose
// `scope` query param is exactly the joined scope list AND retains
// `include_granted_scopes=true` (Google's incremental auth flag).
//
// We test the URL-building layer only — no real SecretsStore round-trip. The
// client_secrets loader is stubbed via a monkey-patch on `getSecretsStore`.

import { OAuthManager } from "../oauth/manager";
import { GSUITE_MANIFEST } from "../services/gsuite/manifest";
import { registerIntegration, getIntegration, _resetRegistry } from "../registry";
import { getSecretsStore } from "../secrets/store";
import type { NormalizedClientSecrets } from "../oauth/manager";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/**
 * Test — `startFlow({ scopes: ["A","B"] })` builds a URL whose scope param
 * contains exactly "A B" and that includes `include_granted_scopes=true` so
 * Google's incremental auth merges the delta with existing grants.
 */
export async function testDeltaScopeAuthUrl(): Promise<void> {
  // Make sure the gsuite manifest is registered (idempotent).
  if (!getIntegration("gsuite")) {
    try {
      registerIntegration(GSUITE_MANIFEST);
    } catch {
      // already registered by a sibling import
    }
  }

  // Stub the SecretsStore's `get` so the manager can pull client credentials
  // without a real keyfile / encrypted blob on disk.
  const store = getSecretsStore();
  const originalGet = store.get.bind(store);
  const stubSecrets: NormalizedClientSecrets = {
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUris: ["http://localhost:3000/api/integrations/oauth/callback"],
    authUri: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUri: "https://oauth2.googleapis.com/token",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).get = async (_integrationId: string, key: string): Promise<unknown> => {
    if (key === "oauth_client") return stubSecrets;
    return null;
  };

  try {
    const manager = new OAuthManager();
    const { authUrl } = await manager.startFlow({
      integrationId: "gsuite",
      scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"],
      origin: "http://localhost:3000",
    });
    const url = new URL(authUrl);
    const scope = url.searchParams.get("scope");
    assert(
      scope === "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
      `unexpected scope param: ${scope}`,
    );
    assert(
      url.searchParams.get("include_granted_scopes") === "true",
      "include_granted_scopes should be true (Google incremental auth)",
    );
    assert(url.searchParams.get("code_challenge_method") === "S256", "PKCE S256 required");
    assert(!!url.searchParams.get("state"), "state token expected");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).get = originalGet;
    // Deliberately do NOT reset the registry so parallel tests can rely on it.
    void _resetRegistry;
  }
}

export async function runAll(): Promise<void> {
  await testDeltaScopeAuthUrl();
}
