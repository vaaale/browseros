// Standalone BOS authentication (034-secrets-authentication, User Story 2, T007).
//   npx playwright test -c playwright.unit.config.ts tests/services/verify-secret-standalone.test.ts
//
// Proves verifySecret(service, raw) accepts a freshly-created secret and
// rejects an incorrect one using ONLY the encrypted store — no Bastion
// process, no routing companion index involved (FR-004). This file
// deliberately imports nothing from credentials-index.ts, so the guarantee
// that authentication never depends on it is visible from the import list
// alone, not just from runtime behavior.
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "./_test-env";
import { _resetKeyCache } from "../../src/lib/integrations/secrets/keyfile";
import { createSecret, verifySecret } from "../../src/lib/secrets/service-secrets";

const SERVICE = "standalone-test";

function setupTest(label: string) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useTestDataDir is a test helper (temp-dir setup), not a React hook
  const { dir, cleanup } = useTestDataDir(label);
  _resetKeyCache();
  return {
    dir,
    dispose: () => {
      _resetKeyCache();
      cleanup();
    },
  };
}

test.describe("standalone authentication (no Bastion, encrypted store only)", () => {
  test("accepts a freshly-created secret's correct raw value", async () => {
    const { dispose } = setupTest("standalone-accept-correct");
    try {
      const created = await createSecret(SERVICE);
      const verified = await verifySecret(SERVICE, created.rawSecret);
      expect(verified.secretId).toBe(created.secretId);
    } finally {
      dispose();
    }
  });

  test("rejects an incorrect raw value", async () => {
    const { dispose } = setupTest("standalone-reject-incorrect");
    try {
      await createSecret(SERVICE);
      await expect(verifySecret(SERVICE, "definitely-not-the-secret")).rejects.toThrow();
    } finally {
      dispose();
    }
  });
});
