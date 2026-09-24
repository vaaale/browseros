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
// The REAL agent store, not a stand-in for what it does. The defect this guards
// lived exactly in the gap between these two modules: each was self-consistent,
// and only their interaction was wrong.
import { listSubAgents } from "../../src/lib/agent/subagents/store";
import { ASSET_BOOKKEEPING_FILES } from "../../src/os/asset-bookkeeping";

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
    // On an AGENT: agents keep the copy-with-provenance contract this test
    // guards. An installed item's SKILLS are symlinked read-only since
    // bos/skill-symlink-install (tests/services/skill-symlink-install.test.ts),
    // so a locally-diverged skill copy can no longer come into existence — but
    // the whole-directory hash property still protects every copied asset.
    const env = useTestDataDir("bundled-multifile");
    try {
      await makeInstalledItem(env.dir, [
        { kind: "agents", id: "multi", files: { "AGENT.md": "v1", "prompts/extra.md": "print(1)" } },
      ]);
      const itemPath = path.join(env.dir, "user-apps", "items", ITEM_ID);
      await seedItemBundledAssets(itemPath, ITEM_ID);

      // Only the HELPER is edited — AGENT.md is byte-identical. Hashing just the
      // entry file would call this "untouched" and destroy the user's edit.
      await fs.writeFile(path.join(env.dir, "agents", "multi", "prompts", "extra.md"), "print(2)", "utf8");
      await fs.writeFile(path.join(itemPath, "agents", "multi", "AGENT.md"), "v2", "utf8");

      const result = await seedItemBundledAssets(itemPath, ITEM_ID);
      expect(result.conflicts.map((c) => c.id)).toEqual(["multi"]);
      expect(await readIfPresent(path.join(env.dir, "agents", "multi", "prompts", "extra.md"))).toBe("print(2)");
    } finally {
      env.cleanup();
    }
  });

  // BOS writing its OWN bookkeeping into an installed asset's directory must not
  // read as a user edit. `backfillLegacyAllowlists()` walks EVERY directory under
  // data/agents/ — marketplace-installed ones included — and drops a
  // `.capabilities-migrated` marker in each. Counting that as content made an
  // untouched installed agent diverge from its own provenance hash, so Settings
  // showed "this agent was edited since it was installed" on an agent nobody had
  // touched, every boot, with no answer that made it stop.
  //
  // Driven through the real agent store rather than by writing the marker by
  // hand: a test that plants `.capabilities-migrated` itself would still pass if
  // someone added a FOURTH marker under a different name, which is the mistake
  // that is actually likely.
  test("BOS's own migration markers are not mistaken for a user edit", async () => {
    const env = useTestDataDir("bundled-bookkeeping");
    try {
      await makeInstalledItem(env.dir, [
        { kind: "agents", id: "helper", files: { "AGENT.md": "---\nname: Helper\ntools: [file_read]\n---\nbody" } },
      ]);
      const itemPath = path.join(env.dir, "user-apps", "items", ITEM_ID);

      // Boot 1: the agent is installed and stamped.
      await reconcileInstalledItemAssets();
      expect(await readIfPresent(path.join(env.dir, "agents", "helper", "AGENT.md"))).toContain("body");

      // The agent store runs its one-time migrations, which write marker files
      // into every agent directory — including this installed one.
      await listSubAgents();

      // Assert the PROPERTY, not the mechanism. An earlier version required the
      // migration to have written >1 dotfile here, which made the test depend on
      // the agent store's one-time backfills not having run yet for this data
      // root — they are memoized per root, so "already done" is a legitimate
      // state and the test failed intermittently on it.
      //
      // What must hold either way: whatever bookkeeping is present, none of it
      // counts as content. So require that some exists (the provenance file
      // always does) and that every dotfile here is declared bookkeeping.
      const dotfiles = (await fs.readdir(path.join(env.dir, "agents", "helper"))).filter((f) => f.startsWith("."));
      expect(dotfiles.length, "provenance at least").toBeGreaterThan(0);
      const undeclared = dotfiles.filter((f) => !ASSET_BOOKKEEPING_FILES.includes(f));
      expect(undeclared, "a dotfile BOS writes here that the hash does not exclude").toEqual([]);

      // Boot 2: nothing about the ASSET changed, so there is nothing to ask about.
      const result = await seedItemBundledAssets(itemPath, ITEM_ID);
      expect(result.conflicts).toEqual([]);
      expect(await listPendingBundledAssetConflicts()).toEqual([]);
    } finally {
      env.cleanup();
    }
  });

  // "Keep mine" used to be a pure no-op: nothing on disk recorded the answer, so
  // the identical question came back on the next reconciliation pass, forever.
  test("keeping the local copy answers the question permanently", async () => {
    const env = useTestDataDir("bundled-keep");
    try {
      await makeInstalledItem(env.dir, [{ kind: "agents", id: "mine", files: { "AGENT.md": "v1" } }]);
      const itemPath = path.join(env.dir, "user-apps", "items", ITEM_ID);
      await seedItemBundledAssets(itemPath, ITEM_ID);

      await fs.writeFile(path.join(env.dir, "agents", "mine", "AGENT.md"), "MY LOCAL EDIT", "utf8");
      await fs.writeFile(path.join(itemPath, "agents", "mine", "AGENT.md"), "v2", "utf8");

      expect((await seedItemBundledAssets(itemPath, ITEM_ID)).conflicts.map((c) => c.id)).toEqual(["mine"]);
      await resolvePendingBundledAssetConflict("agent", "mine", "keep");

      // Asked and answered. The local copy stands and is not re-litigated.
      const again = await seedItemBundledAssets(itemPath, ITEM_ID);
      expect(again.conflicts).toEqual([]);
      expect(again.replaced).toEqual([]);
      expect(await readIfPresent(path.join(env.dir, "agents", "mine", "AGENT.md"))).toBe("MY LOCAL EDIT");
      expect(await listPendingBundledAssetConflicts()).toEqual([]);

      // A NEW version of the asset is a NEW question, so it is asked again.
      await fs.writeFile(path.join(itemPath, "agents", "mine", "AGENT.md"), "v3", "utf8");
      expect((await seedItemBundledAssets(itemPath, ITEM_ID)).conflicts.map((c) => c.id)).toEqual(["mine"]);
    } finally {
      env.cleanup();
    }
  });

  // The same loop, for the conflict kind that had no provenance to write to.
  test("keeping an unknown-provenance copy also stops the prompt", async () => {
    const env = useTestDataDir("bundled-keep-unknown");
    try {
      await makeInstalledItem(env.dir, [{ kind: "skills", id: "pre-existing", files: { "SKILL.md": "theirs" } }]);
      const itemPath = path.join(env.dir, "user-apps", "items", ITEM_ID);

      // A copy BOS did not install — no provenance, so never overwritten.
      const dest = path.join(env.dir, "skills", "pre-existing");
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "SKILL.md"), "mine, from before", "utf8");

      expect((await seedItemBundledAssets(itemPath, ITEM_ID)).conflicts.map((c) => c.reason)).toEqual([
        "unknown-provenance",
      ]);
      await resolvePendingBundledAssetConflict("skill", "pre-existing", "keep");

      const again = await seedItemBundledAssets(itemPath, ITEM_ID);
      expect(again.conflicts).toEqual([]);
      expect(await readIfPresent(path.join(dest, "SKILL.md"))).toBe("mine, from before");
    } finally {
      env.cleanup();
    }
  });
});

test("an unreadable directory is an ERROR, never a hash of nothing", async () => {
  // Every decision in this module is "are these two hashes equal". A walk that
  // swallowed a failed readdir returned the digest of FEWER files — in the worst
  // case of an empty list, which any two unreadable assets both produce. That
  // does not fail loudly: it makes unequal things compare EQUAL, so the seed
  // skips an update it should apply, or overwrites an edit it should preserve.
  //
  // Suspected in an intermittent failure of the test above, where an asset that
  // should have been replaced stayed at its old content with nothing reported.
  const env = useTestDataDir("bundled-unreadable");
  try {
    await makeInstalledItem(env.dir, [{ kind: "agents", id: "a", files: { "AGENT.md": "v1" } }]);
    const itemPath = path.join(env.dir, "user-apps", "items", ITEM_ID);
    await seedItemBundledAssets(itemPath, ITEM_ID);

    // Make the SOURCE unreadable — not absent. Absent is a normal state and must
    // stay silent; unreadable is a failure and must not look like it.
    const src = path.join(itemPath, "agents");
    await fs.chmod(src, 0o000);
    try {
      const result = await seedItemBundledAssets(itemPath, ITEM_ID);
      // It contains its own failure — an install must not break because a bundled
      // extra was unreadable — but it REPORTS rather than returning a result that
      // is byte-identical to "there was nothing to do". That equivalence is what
      // let a transient read failure present as a silent no-op.
      expect(result.failures.length, "the failure reaches the CALLER, not just the log").toBeGreaterThan(0);
      expect(result.installed).toEqual([]);
      expect(result.replaced).toEqual([]);
    } finally {
      await fs.chmod(src, 0o755);
    }

    // And the ABSENT case stays silent, because that is the normal one.
    await fs.rm(src, { recursive: true, force: true });
    const quiet = await seedItemBundledAssets(itemPath, ITEM_ID);
    expect(quiet, "absent is silent — it is the normal case").toEqual({ installed: [], replaced: [], conflicts: [], failures: [] });
  } finally {
    env.cleanup();
  }
});
