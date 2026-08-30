// Bundled agents/skills carried by a marketplace item (040-okf-knowledge-base):
//   npx playwright test -c playwright.unit.config.ts tests/services/bundled-assets.test.ts
//
// The properties that matter are the ones a silent bug would hide: an item that
// GAINS an asset must pick it up without a reinstall, an untouched copy may be
// replaced, and a locally-edited one must never be clobbered.

import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "./_test-env";
import { promises as fs } from "fs";
import path from "path";
// Static imports: Playwright rewrites the `@/` tsconfig alias at transform
// time, but a runtime `await import()` would hit Node's resolver, which does
// not know it. dataDir() is read per call, so importing early is safe.
import {
  seedItemBundledAssets,
  reconcileInstalledItemAssets,
  listPendingBundledAssetConflicts,
  resolvePendingBundledAssetConflict,
} from "../../src/system/marketplace/install/bundledAssets";

const ITEM_ID = "test-item";

/** Build an item dir with the given bundled assets, and install it (the 035 symlink). */
async function makeInstalledItem(
  dataDirPath: string,
  assets: { kind: "agents" | "skills"; id: string; files: Record<string, string> }[],
): Promise<string> {
  const itemPath = path.join(dataDirPath, "user-apps", "items", ITEM_ID);
  for (const a of assets) {
    for (const [rel, content] of Object.entries(a.files)) {
      const full = path.join(itemPath, a.kind, a.id, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    }
  }
  const link = path.join(dataDirPath, "system", ITEM_ID);
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.rm(link, { force: true });
  await fs.symlink(itemPath, link, "dir");
  return itemPath;
}

const readIfPresent = (p: string) => fs.readFile(p, "utf8").catch(() => null);

test.describe("bundled assets — reconciliation", () => {
  test("an ALREADY-INSTALLED item that gains an agent picks it up with no reinstall", async () => {
    const env = useTestDataDir("bundled-reconcile");
    try {
      // The item is installed FIRST with nothing bundled — the symlink exists
      // and will never be rewritten again, exactly like a real install that
      // predates the item gaining an agent.
      await makeInstalledItem(env.dir, []);

      // Now the item gains one, as an item author would by shipping an update.
      await makeInstalledItem(env.dir, [
        { kind: "agents", id: "helper", files: { "AGENT.md": "---\nname: Helper\n---\nbody v1" } },
        { kind: "skills", id: "proc", files: { "SKILL.md": "---\nname: Proc\n---\nsteps" } },
      ]);

      await reconcileInstalledItemAssets();

      expect(await readIfPresent(path.join(env.dir, "agents", "helper", "AGENT.md"))).toContain("body v1");
      expect(await readIfPresent(path.join(env.dir, "skills", "proc", "SKILL.md"))).toContain("steps");
    } finally {
      env.cleanup();
    }
  });

  test("an untouched asset is replaced; a locally-edited one is preserved as a conflict", async () => {
    const env = useTestDataDir("bundled-conflict");
    try {
      await makeInstalledItem(env.dir, [
        { kind: "agents", id: "untouched", files: { "AGENT.md": "v1" } },
        { kind: "agents", id: "edited", files: { "AGENT.md": "v1" } },
      ]);
      const itemPath = path.join(env.dir, "user-apps", "items", ITEM_ID);

      await seedItemBundledAssets(itemPath, ITEM_ID);
      expect(await readIfPresent(path.join(env.dir, "agents", "untouched", "AGENT.md"))).toBe("v1");

      // The user edits one of the installed copies.
      await fs.writeFile(path.join(env.dir, "agents", "edited", "AGENT.md"), "MY LOCAL EDIT", "utf8");

      // The item ships v2 of both.
      await fs.writeFile(path.join(itemPath, "agents", "untouched", "AGENT.md"), "v2", "utf8");
      await fs.writeFile(path.join(itemPath, "agents", "edited", "AGENT.md"), "v2", "utf8");

      const result = await seedItemBundledAssets(itemPath, ITEM_ID);

      // Untouched → silently updated. Edited → left alone, reported.
      expect(await readIfPresent(path.join(env.dir, "agents", "untouched", "AGENT.md"))).toBe("v2");
      expect(await readIfPresent(path.join(env.dir, "agents", "edited", "AGENT.md"))).toBe("MY LOCAL EDIT");
      expect(result.replaced.map((r) => r.id)).toEqual(["untouched"]);
      expect(result.conflicts.map((c) => c.id)).toEqual(["edited"]);

      // The conflict is durable — a headless install must still surface it later.
      const pending = await listPendingBundledAssetConflicts();
      expect(pending.map((c) => c.id)).toEqual(["edited"]);

      // Resolving with "replace" applies the deferred update.
      await resolvePendingBundledAssetConflict("agent", "edited", "replace");
      expect(await readIfPresent(path.join(env.dir, "agents", "edited", "AGENT.md"))).toBe("v2");
      expect(await listPendingBundledAssetConflicts()).toEqual([]);
    } finally {
      env.cleanup();
    }
  });

  test("editing a bundled helper file counts as divergence, not just the entry file", async () => {
    const env = useTestDataDir("bundled-multifile");
    try {
      await makeInstalledItem(env.dir, [
        { kind: "skills", id: "multi", files: { "SKILL.md": "v1", "scripts/run.py": "print(1)" } },
      ]);
      const itemPath = path.join(env.dir, "user-apps", "items", ITEM_ID);
      await seedItemBundledAssets(itemPath, ITEM_ID);

      // Only the SCRIPT is edited — SKILL.md is byte-identical. Hashing just the
      // entry file would call this "untouched" and destroy the user's edit.
      await fs.writeFile(path.join(env.dir, "skills", "multi", "scripts", "run.py"), "print(2)", "utf8");
      await fs.writeFile(path.join(itemPath, "SKILL.md"), "v1", "utf8").catch(() => {});
      await fs.writeFile(path.join(itemPath, "skills", "multi", "SKILL.md"), "v2", "utf8");

      const result = await seedItemBundledAssets(itemPath, ITEM_ID);
      expect(result.conflicts.map((c) => c.id)).toEqual(["multi"]);
      expect(await readIfPresent(path.join(env.dir, "skills", "multi", "scripts", "run.py"))).toBe("print(2)");
    } finally {
      env.cleanup();
    }
  });
});
