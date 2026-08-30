// service-secrets: createSecret / verifySecret / listSecrets / revokeSecret /
// hasAnySecret, and their wiring into credentials-index.ts.
//   npx playwright test -c playwright.unit.config.ts tests/services/service-secrets.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "./_test-env";
import { _resetKeyCache } from "../../src/lib/integrations/secrets/keyfile";
import {
  createSecret,
  verifySecret,
  listSecrets,
  revokeSecret,
  hasAnySecret,
} from "../../src/lib/secrets/service-secrets";
import { readIndex } from "../../src/lib/secrets/credentials-index";

// Self-contained example namespaces (spec.md User Story 1) — distinct from
// any real BOS service, per project convention for this feature's own
// acceptance testing.
const SERVICE_A = "test-example-protocol-a";
const SERVICE_B = "test-example-protocol-b";

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

test.describe("service-secrets", () => {
  test("create/verify/list/revoke round-trip", async () => {
    const { dispose } = setupTest("svc-secrets-roundtrip");
    try {
      expect(await hasAnySecret(SERVICE_A)).toBe(false);

      const created = await createSecret(SERVICE_A, "my label");
      expect(created.rawSecret.length).toBeGreaterThan(0);
      expect(created.service).toBe(SERVICE_A);

      expect(await hasAnySecret(SERVICE_A)).toBe(true);

      const verified = await verifySecret(SERVICE_A, created.rawSecret);
      expect(verified.secretId).toBe(created.secretId);
      expect(verified.label).toBe("my label");

      const listed = await listSecrets(SERVICE_A);
      expect(listed).toHaveLength(1);
      expect(listed[0].secretId).toBe(created.secretId);
      expect(JSON.stringify(listed)).not.toContain(created.rawSecret);

      await revokeSecret(SERVICE_A, created.secretId);
      expect(await hasAnySecret(SERVICE_A)).toBe(false);
      await expect(verifySecret(SERVICE_A, created.rawSecret)).rejects.toThrow();
    } finally {
      dispose();
    }
  });

  test("rejects an incorrect candidate", async () => {
    const { dispose } = setupTest("svc-secrets-wrong-candidate");
    try {
      const created = await createSecret(SERVICE_A);
      await expect(verifySecret(SERVICE_A, "not-the-secret")).rejects.toThrow();
      await verifySecret(SERVICE_A, created.rawSecret); // sanity: correct value still verifies
    } finally {
      dispose();
    }
  });

  test("namespace isolation: a secret from one service is rejected under another", async () => {
    const { dispose } = setupTest("svc-secrets-namespace-isolation");
    try {
      const created = await createSecret(SERVICE_A);
      await expect(verifySecret(SERVICE_B, created.rawSecret)).rejects.toThrow();
    } finally {
      dispose();
    }
  });

  test("createSecret writes a companion credentials-index entry; revokeSecret removes it", async () => {
    const { dispose } = setupTest("svc-secrets-index-wiring");
    try {
      await createSecret(SERVICE_A);
      const afterCreate = Object.values((await readIndex()).entries);
      expect(afterCreate.some((e) => e.service === SERVICE_A)).toBe(true);

      const [{ secretId }] = await listSecrets(SERVICE_A);
      await revokeSecret(SERVICE_A, secretId);

      const afterRevoke = Object.values((await readIndex()).entries);
      expect(afterRevoke.some((e) => e.service === SERVICE_A)).toBe(false);
    } finally {
      dispose();
    }
  });

  test("revoking an unknown secretId is a no-op", async () => {
    const { dispose } = setupTest("svc-secrets-revoke-unknown");
    try {
      await expect(revokeSecret(SERVICE_A, "does-not-exist")).resolves.toBeUndefined();
    } finally {
      dispose();
    }
  });

  test("rejects a service name containing ':' (would break prefix-based namespace isolation)", async () => {
    const { dispose } = setupTest("svc-secrets-colon-guard");
    try {
      await expect(createSecret("a:b")).rejects.toThrow();
      await expect(verifySecret("a:b", "whatever")).rejects.toThrow();
      await expect(listSecrets("a:b")).rejects.toThrow();
      await expect(revokeSecret("a:b", "whatever")).rejects.toThrow();
      await expect(hasAnySecret("a:b")).rejects.toThrow();
    } finally {
      dispose();
    }
  });
});
