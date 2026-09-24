// Skills carried by an INSTALLED item are symlinked, read-only — never copied.
//   npm run test:unit -- tests/services/skill-symlink-install.test.ts
//
// Reproduces two field defects from a production box (2026-09-22):
//
//   1. A marketplace skill item showed "✓ installed" (green) but uninstall threw
//      `"<id>" is not installed.` — install went through installSkill() → a COPY
//      into data/skills/ with no data/system/<id> link, while uninstall-item
//      required the link. Two sources of truth for "installed".
//   2. Uninstalling BMAD removed its item link and left all 30 skill COPIES
//      orphaned in data/skills/ — uninstallMarketplaceItem had no bundled-asset
//      step at all.
//
// The fix is a design change, not a patch: a bundled skill of an installed item
// is a RELATIVE symlink data/skills/<id> → ../system/<itemId>/skills/<id>,
// routed through the 035 item link. Uninstalling the item removes the links;
// the store treats a symlinked skill as read-only (its content lives in the
// marketplace clone, where `git pull` updates it in place). Skills whose source
// is NOT an installed item — BOS's own seed/skills/, the built-in spec-kit pack
// whose root is in the SOURCE TREE (which no data/ symlink may point into: data/
// outlives any one worktree) — keep the copy-with-provenance contract.

import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "./_test-env";
import { promises as fs } from "fs";
import path from "path";
// Static imports: Playwright rewrites the `@/` alias at transform time, but a
// runtime `await import()` would hit Node's resolver, which does not know it.
// dataDir() is read per call, so importing early is safe.
import {
  seedItemBundledAssets,
  seedPackBundledSkills,
  listPendingBundledAssetConflicts,
  resolvePendingBundledAssetConflict,
} from "../../src/system/marketplace/install/bundledAssets";
import { installItemLink, uninstallItemLink } from "../../src/system/marketplace/install/symlinkManager";
// The REAL skills store — the defects lived in the gap between the install
// machinery and this store, so a stand-in for either would test nothing.
import {
  listSkills,
  getSkill,
  saveSkill,
  patchSkill,
  removeSkill,
  archiveSkill,
  stageSkillFiles,
  readSkillFile,
} from "../../src/lib/agent/skills/store";
import { PROVENANCE_FILE } from "../../src/os/asset-bookkeeping";
import { installSkill, uninstallMarketplaceItem } from "../../src/lib/marketplace/client";
import { getInstalledItem } from "../../src/system/items/installed";

const ITEM_ID = "test-symlink-item";

const SKILL_MD = (name: string, body: string) => `---\nname: ${name}\ndescription: a bundled skill\n---\n${body}\n`;

/** Build an item dir under user-apps/items/<id> with bundled skills. Does NOT
 *  install it — tests that need the 035 link call installItemLink themselves. */
async function makeItemDir(
  dataDirPath: string,
  skills: { id: string; files: Record<string, string> }[],
): Promise<string> {
  const itemPath = path.join(dataDirPath, "user-apps", "items", ITEM_ID);
  await fs.mkdir(itemPath, { recursive: true });
  for (const s of skills) {
    for (const [rel, content] of Object.entries(s.files)) {
      const full = path.join(itemPath, "skills", s.id, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    }
  }
  return itemPath;
}

const lstatType = async (p: string): Promise<"symlink" | "dir" | "file" | "absent"> => {
  try {
    const st = await fs.lstat(p);
    return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
  } catch {
    return "absent";
  }
};

test.describe("skills of an installed item are symlinked and read-only", () => {
  test("installItemLink symlinks a bundled skill relatively through the item link", async () => {
    const env = useTestDataDir("skill-symlink-install");
    try {
      const itemPath = await makeItemDir(env.dir, [
        { id: "proc", files: { "SKILL.md": SKILL_MD("Proc", "the steps"), "references/notes.md": "ref body" } },
      ]);

      const result = await installItemLink(itemPath, ITEM_ID);
      expect(result.conflicts).toEqual([]);

      const linkPath = path.join(env.dir, "skills", "proc");
      expect(await lstatType(linkPath)).toBe("symlink");
      // RELATIVE, through the item link — an absolute target would break inside
      // a branch data clone, and a target into the clone directly would survive
      // uninstall. `../system/<itemId>/skills/<id>` fails safe on both counts.
      expect(await fs.readlink(linkPath)).toBe(path.join("..", "system", ITEM_ID, "skills", "proc"));

      // No provenance bookkeeping may be written THROUGH the link into the
      // item's own directory — the symlink itself is the provenance.
      expect(await lstatType(path.join(itemPath, "skills", "proc", PROVENANCE_FILE))).toBe("absent");

      // The real store reads it through the link and reports it read-only.
      const skill = await getSkill("proc");
      expect(skill?.content).toContain("the steps");
      expect(skill?.readOnly).toBe(true);
      expect(skill?.sourceItemId).toBe(ITEM_ID);
      expect(await readSkillFile("proc", "references/notes.md")).toBe("ref body");
      expect((await listSkills()).find((s) => s.id === "proc")?.readOnly).toBe(true);

      // Re-seeding is idempotent: the existing symlink is recognised, not
      // hashed against provenance it doesn't have (that would raise a bogus
      // "unknown-provenance" conflict on every reconcile pass, forever).
      const again = await seedItemBundledAssets(itemPath, ITEM_ID);
      expect(again.conflicts).toEqual([]);
      expect(again.installed).toEqual([]);
      expect(await lstatType(linkPath)).toBe("symlink");
    } finally {
      env.cleanup();
    }
  });

  test("a read-only skill refuses every mutation and nothing writes through the link", async () => {
    const env = useTestDataDir("skill-symlink-readonly");
    try {
      const itemPath = await makeItemDir(env.dir, [
        { id: "proc", files: { "SKILL.md": SKILL_MD("Proc", "original body") } },
      ]);
      await installItemLink(itemPath, ITEM_ID);
      const sourceFile = path.join(itemPath, "skills", "proc", "SKILL.md");
      const before = await fs.readFile(sourceFile, "utf8");

      // saveSkill (also the path under skill_improve and PUT /api/skills).
      await expect(
        saveSkill({ name: "Proc", description: "edited", content: "overwritten" }),
      ).rejects.toThrow(/read-only/i);

      // patchSkill reports through its error channel — the LLM tool surface.
      const patched = await patchSkill("proc", "original", "changed");
      expect("error" in patched && patched.error).toMatch(/read-only/i);

      await expect(removeSkill("proc")).rejects.toThrow(/read-only/i);
      expect(await archiveSkill("proc")).toBe(false);

      // The one catastrophic failure mode: a write that lands INSIDE the
      // marketplace clone through the link. Nothing above may have moved it.
      expect(await fs.readFile(sourceFile, "utf8")).toBe(before);
      expect(await lstatType(path.join(env.dir, "skills", "proc"))).toBe("symlink");
    } finally {
      env.cleanup();
    }
  });

  test("uninstalling the item removes its skill symlinks and nothing else (BMAD repro)", async () => {
    const env = useTestDataDir("skill-symlink-uninstall");
    try {
      const itemPath = await makeItemDir(env.dir, [
        { id: "proc", files: { "SKILL.md": SKILL_MD("Proc", "steps") } },
        { id: "review", files: { "SKILL.md": SKILL_MD("Review", "review steps") } },
      ]);
      await installItemLink(itemPath, ITEM_ID);

      // A user's own skill sitting next to the item's — must survive untouched.
      const ownDir = path.join(env.dir, "skills", "my-own");
      await fs.mkdir(ownDir, { recursive: true });
      await fs.writeFile(path.join(ownDir, "SKILL.md"), SKILL_MD("My Own", "mine"), "utf8");

      await uninstallItemLink(ITEM_ID);

      expect(await lstatType(path.join(env.dir, "skills", "proc"))).toBe("absent");
      expect(await lstatType(path.join(env.dir, "skills", "review"))).toBe("absent");
      expect(await lstatType(ownDir)).toBe("dir");
      // The item's own source is not ours to touch (it lives in a marketplace
      // clone or the user's repo).
      expect(await lstatType(path.join(itemPath, "skills", "proc", "SKILL.md"))).toBe("file");
    } finally {
      env.cleanup();
    }
  });

  test("an untouched pre-symlink COPY migrates; an edited one is preserved as a conflict", async () => {
    const env = useTestDataDir("skill-symlink-migrate");
    try {
      const itemPath = await makeItemDir(env.dir, [
        { id: "untouched", files: { "SKILL.md": SKILL_MD("Untouched", "v1") } },
        { id: "edited", files: { "SKILL.md": SKILL_MD("Edited", "v1") } },
      ]);

      // Legacy state, produced by the REAL copy mechanism: seeding before the
      // item link exists is copy-mode (same as every pre-symlink deployment).
      const first = await seedItemBundledAssets(itemPath, ITEM_ID);
      expect(first.installed.map((a) => a.id).sort()).toEqual(["edited", "untouched"]);
      expect(await lstatType(path.join(env.dir, "skills", "untouched"))).toBe("dir");

      // The user edits one copy — that edit is theirs and must never be lost.
      const editedFile = path.join(env.dir, "skills", "edited", "SKILL.md");
      await fs.writeFile(editedFile, SKILL_MD("Edited", "my local changes"), "utf8");

      await installItemLink(itemPath, ITEM_ID);

      expect(await lstatType(path.join(env.dir, "skills", "untouched"))).toBe("symlink");
      expect(await lstatType(path.join(env.dir, "skills", "edited"))).toBe("dir");
      expect(await fs.readFile(editedFile, "utf8")).toContain("my local changes");

      const conflicts = await listPendingBundledAssetConflicts();
      expect(conflicts.map((c) => c.id)).toContain("edited");

      // "replace" resolution now lands on the new contract: a symlink.
      await resolvePendingBundledAssetConflict("skill", "edited", "replace");
      expect(await lstatType(path.join(env.dir, "skills", "edited"))).toBe("symlink");
      expect((await getSkill("edited"))?.content).toContain("v1");
    } finally {
      env.cleanup();
    }
  });

  test("a pack root that is NOT an installed item still copies (built-in spec-kit)", async () => {
    const env = useTestDataDir("skill-symlink-pack-copy");
    try {
      // A pack root outside data/system — like seed/method-packs/spec-kit,
      // which lives in the SOURCE TREE. A symlink from data/ into a worktree
      // would dangle after the next promote; the copy contract stays.
      const packPath = path.join(env.dir, "not-an-item", "spec-kit");
      const skillFile = path.join(packPath, "skills", "driver", "SKILL.md");
      await fs.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.writeFile(skillFile, SKILL_MD("Driver", "drive the pipeline"), "utf8");

      await seedPackBundledSkills(packPath, "spec-kit-test");

      expect(await lstatType(path.join(env.dir, "skills", "driver"))).toBe("dir");
      const skill = await getSkill("driver");
      expect(skill?.readOnly).toBeFalsy();
      // Still mutable — the reflective optimizer may rewrite a copied skill.
      const saved = await saveSkill({ name: "Driver", description: "d", content: "improved" });
      expect(saved.id).toBe("driver");
    } finally {
      env.cleanup();
    }
  });

  test("stageSkillFiles stages REAL files from a symlinked skill", async () => {
    const env = useTestDataDir("skill-symlink-stage");
    try {
      const itemPath = await makeItemDir(env.dir, [
        { id: "proc", files: { "SKILL.md": SKILL_MD("Proc", "steps"), "scripts/run.py": "print('hi')" } },
      ]);
      await installItemLink(itemPath, ITEM_ID);

      const dest = path.join(env.dir, "staged");
      expect(await stageSkillFiles("proc", dest)).toBe(true);
      // fs.cp without dereference would reproduce the SYMLINK in the sandbox,
      // where ../system/<id>/ resolves to nothing and every script path breaks.
      expect(await lstatType(path.join(dest, "SKILL.md"))).toBe("file");
      expect(await fs.readFile(path.join(dest, "scripts", "run.py"), "utf8")).toBe("print('hi')");
    } finally {
      env.cleanup();
    }
  });
});

test.describe("skill-facet items install and uninstall through the ONE item mechanism", () => {
  /** A marketplace clone carrying one skill-only item, superpowers-style:
   *  SKILL.md at the skill folder root, no items/<id>/ directory at all. */
  async function makeSkillMarketplace(dataDirPath: string): Promise<string> {
    const mktId = "skilltest";
    const root = path.join(dataDirPath, "marketplace", mktId);
    const skillFile = path.join(root, "skills", "neat-skill", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, SKILL_MD("Neat Skill", "be neat"), "utf8");
    await fs.writeFile(
      path.join(root, "marketplace.json"),
      JSON.stringify({
        id: mktId,
        name: "Skill Test",
        version: "1.0.0",
        items: [
          {
            id: "neat-skill",
            name: "Neat Skill",
            description: "a skill-only item",
            skill: { path: "skills/neat-skill", version: "1.0.0" },
          },
        ],
      }),
      "utf8",
    );
    return mktId;
  }

  test("the field repro: green install, then uninstall-item threw `not installed`", async () => {
    const env = useTestDataDir("skill-item-symmetry");
    try {
      const mktId = await makeSkillMarketplace(env.dir);

      const { skillId } = await installSkill(mktId, "neat-skill");
      expect(skillId).toBe("neat-skill");

      // Install now IS the 035 symlink — the item link is what makes
      // uninstall-item resolvable, where before there were two sources of
      // truth ("green" read data/skills/, uninstall read data/system/).
      expect(await getInstalledItem("neat-skill")).not.toBeNull();
      expect(await lstatType(path.join(env.dir, "system", "neat-skill"))).toBe("symlink");
      const skillLink = path.join(env.dir, "skills", "neat-skill");
      expect(await lstatType(skillLink)).toBe("symlink");
      expect(await fs.readlink(skillLink)).toBe(path.join("..", "system", "neat-skill"));
      expect((await getSkill("neat-skill"))?.readOnly).toBe(true);

      // This exact call threw `"neat-skill" is not installed.` on the prod box.
      await uninstallMarketplaceItem("neat-skill");

      expect(await lstatType(path.join(env.dir, "system", "neat-skill"))).toBe("absent");
      expect(await lstatType(skillLink)).toBe("absent");
      // The clone is the marketplace's, not ours to empty.
      expect(await lstatType(path.join(env.dir, "marketplace", mktId, "skills", "neat-skill", "SKILL.md"))).toBe("file");
    } finally {
      env.cleanup();
    }
  });
});
