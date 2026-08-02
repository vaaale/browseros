// bastion/src/credential-routing.ts unit tests (034-secrets-authentication, T008)
//   npx playwright test -c playwright.unit.config.ts tests/bastion/credential-routing.test.ts
//
// Exercises resolveCredential() against fixture directories representing
// several provisioned users — no live Docker/Keycloak involved. Covers:
// match found, no match, and one user's corrupted index file not breaking the
// scan for others (spec.md Edge Cases).

import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { resolveCredential } from "../../bastion/src/credential-routing";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function makeUsersRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = path.join(os.tmpdir(), `bos-cred-routing-test-${randomBytes(6).toString("hex")}`);
  await fs.mkdir(root, { recursive: true });
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function writeIndex(
  usersRoot: string,
  username: string,
  entries: Record<string, { service: string; createdAt: string }>,
): Promise<void> {
  const dir = path.join(usersRoot, username, "data", "system");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "credentials-index.json"),
    JSON.stringify({ version: 1, entries }, null, 2),
  );
}

test.describe("resolveCredential", () => {
  test("finds a match among several provisioned users", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      const secretAlice = "alice-secret-value";
      const secretBob = "bob-secret-value";

      await writeIndex(root, "alice", {
        [sha256(secretAlice)]: { service: "example-protocol", createdAt: new Date().toISOString() },
      });
      await writeIndex(root, "bob", {
        [sha256(secretBob)]: { service: "example-protocol", createdAt: new Date().toISOString() },
      });

      const resolved = await resolveCredential(secretBob, root);
      expect(resolved).toEqual({ username: "bob", service: "example-protocol" });
    } finally {
      await cleanup();
    }
  });

  test("returns null when no provisioned user's index has a match", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      await writeIndex(root, "alice", {
        [sha256("alice-secret-value")]: { service: "example-protocol", createdAt: new Date().toISOString() },
      });

      const resolved = await resolveCredential("never-minted-value", root);
      expect(resolved).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("a corrupted index file for one user doesn't break the scan for others", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      const secretCarol = "carol-secret-value";

      // "bad" has a corrupted (non-JSON) index file.
      const badDir = path.join(root, "bad", "data", "system");
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(path.join(badDir, "credentials-index.json"), "{ not valid json");

      // "empty" has no index file at all.
      await fs.mkdir(path.join(root, "empty"), { recursive: true });

      await writeIndex(root, "carol", {
        [sha256(secretCarol)]: { service: "example-protocol", createdAt: new Date().toISOString() },
      });

      const resolved = await resolveCredential(secretCarol, root);
      expect(resolved).toEqual({ username: "carol", service: "example-protocol" });
    } finally {
      await cleanup();
    }
  });

  test("returns null (not throw) when the users root itself doesn't exist", async () => {
    const missingRoot = path.join(os.tmpdir(), `bos-cred-routing-missing-${randomBytes(6).toString("hex")}`);
    await expect(resolveCredential("whatever", missingRoot)).resolves.toBeNull();
  });
});
