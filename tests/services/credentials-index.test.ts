// credentials-index: readIndex / writeIndexEntry / removeIndexEntry
//   npx playwright test -c playwright.unit.config.ts tests/services/credentials-index.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { useTestDataDir } from "./_test-env";
import { readIndex, writeIndexEntry, removeIndexEntry } from "../../src/lib/secrets/credentials-index";

test.describe("credentials-index", () => {
  test("write/read/remove round-trip, preserving other entries", async () => {
    const { cleanup } = useTestDataDir("creds-index-roundtrip");
    try {
      expect(await readIndex()).toEqual({ version: 1, entries: {} });

      await writeIndexEntry("hash-a", "service-a");
      await writeIndexEntry("hash-b", "service-b");

      const afterWrite = await readIndex();
      expect(Object.keys(afterWrite.entries)).toHaveLength(2);
      expect(afterWrite.entries["hash-a"].service).toBe("service-a");
      expect(afterWrite.entries["hash-b"].service).toBe("service-b");

      await removeIndexEntry("hash-a");
      const afterRemove = await readIndex();
      expect(afterRemove.entries["hash-a"]).toBeUndefined();
      expect(afterRemove.entries["hash-b"].service).toBe("service-b");
    } finally {
      cleanup();
    }
  });

  test("removing a non-existent entry is a no-op, not an error", async () => {
    const { cleanup } = useTestDataDir("creds-index-remove-missing");
    try {
      await expect(removeIndexEntry("does-not-exist")).resolves.toBeUndefined();
      expect(await readIndex()).toEqual({ version: 1, entries: {} });
    } finally {
      cleanup();
    }
  });

  test("a missing index file reads as empty", async () => {
    const { cleanup } = useTestDataDir("creds-index-missing-file");
    try {
      expect(await readIndex()).toEqual({ version: 1, entries: {} });
    } finally {
      cleanup();
    }
  });

  test("a corrupted index file reads as empty rather than throwing", async () => {
    const { dir, cleanup } = useTestDataDir("creds-index-corrupted");
    try {
      const systemDir = join(dir, "system");
      mkdirSync(systemDir, { recursive: true });
      writeFileSync(join(systemDir, "credentials-index.json"), "{ not valid json");

      expect(await readIndex()).toEqual({ version: 1, entries: {} });
    } finally {
      cleanup();
    }
  });
});
