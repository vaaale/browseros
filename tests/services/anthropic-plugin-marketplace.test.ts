// Reproduction: adding https://github.com/obra/superpowers listed ZERO skills.
// That repo is a standard Claude Code plugin marketplace — .claude-plugin/
// marketplace.json whose plugin entry has `source: "./"` and NO `skills` array,
// because in that format `skills` is optional: omitted means "auto-discover
// from <source>/skills/*/SKILL.md". convertAnthropicPlugin() only read the
// explicit array:
//     const skills = Array.isArray(plugin.skills) ? (plugin.skills as unknown[]) : [];
// so every such marketplace synthesized an empty items[] and registered as a
// marketplace with nothing in it. The plugin entry is also where the version
// lives (`plugins[0].version`), not `metadata.version`, so even discovered
// skills came out "0.0.0".
//   npm run test:unit -- tests/services/anthropic-plugin-marketplace.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { listCatalog, addMarketplace } from "../../src/lib/marketplace/client";
import { useTestDataDir, resetServiceSingletons } from "./_test-env";

function gitCommitAll(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd });
}

function writeSkill(repoDir: string, relDir: string, name: string, description: string): void {
  const dir = join(repoDir, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", `name: ${name}`, `description: ${description}`, "---", "# Body"].join("\n"));
}

function setupTest(label: string) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useTestDataDir is a test helper (temp-dir setup), not a React hook
  const { dir, cleanup } = useTestDataDir(label);
  resetServiceSingletons();
  return {
    dir,
    dispose: () => {
      resetServiceSingletons();
      cleanup();
    },
  };
}

test.describe("Anthropic plugin marketplace (.claude-plugin/marketplace.json)", () => {
  test("a plugin without a skills[] array gets its skills auto-discovered from <source>/skills/", async () => {
    const { dir, dispose } = setupTest("anthropic-autodiscover");
    try {
      // The exact Superpowers shape: one plugin, source "./", no `skills` key,
      // version on the plugin entry, no top-level `metadata`.
      const repo = join(dir, "superpowers-like");
      mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(repo, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "superpowers-dev",
          owner: { name: "Jesse Vincent" },
          plugins: [
            { name: "superpowers", description: "Core skills library", version: "6.4.1", source: "./" },
          ],
        }),
      );
      writeSkill(repo, "skills/brainstorming", "brainstorming", '"You MUST use this before any creative work."');
      writeSkill(repo, "skills/test-driven-development", "test-driven-development", "Write the failing test first.");
      // A folder without SKILL.md is not a skill and must not be offered.
      mkdirSync(join(repo, "skills", "not-a-skill"), { recursive: true });
      writeFileSync(join(repo, "skills", "not-a-skill", "README.md"), "stray folder");
      gitCommitAll(repo);

      const reg = await addMarketplace(repo);
      expect(reg.id).toBe("superpowers-dev");

      const entry = (await listCatalog()).find((m) => m.id === "superpowers-dev");
      expect(entry).toBeDefined();
      const ids = entry!.items.map((i) => i.id).sort();
      expect(ids).toEqual(["brainstorming", "test-driven-development"]);

      const bs = entry!.items.find((i) => i.id === "brainstorming")!;
      expect(bs.skill?.path).toBe("skills/brainstorming");
      // Version comes from the plugin entry, not the absent metadata.version.
      expect(bs.skill?.version).toBe("6.4.1");
      // Frontmatter description, surrounding quotes stripped.
      expect(bs.description).toBe("You MUST use this before any creative work.");
    } finally {
      dispose();
    }
  });

  test("auto-discovery follows a plugin's source subdirectory", async () => {
    const { dir, dispose } = setupTest("anthropic-source-subdir");
    try {
      const repo = join(dir, "packs");
      mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(repo, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "pack-market",
          plugins: [{ name: "pack", version: "1.2.3", source: "./plugins/pack" }],
        }),
      );
      writeSkill(repo, "plugins/pack/skills/deep-focus", "deep-focus", "Focus deeply.");
      gitCommitAll(repo);

      await addMarketplace(repo);
      const entry = (await listCatalog()).find((m) => m.id === "pack-market");
      const item = entry?.items.find((i) => i.id === "deep-focus");
      expect(item?.skill?.path).toBe("plugins/pack/skills/deep-focus");
      expect(item?.skill?.version).toBe("1.2.3");
    } finally {
      dispose();
    }
  });

  test("an explicit skills[] array still wins over auto-discovery, with metadata.version", async () => {
    const { dir, dispose } = setupTest("anthropic-explicit-skills");
    try {
      const repo = join(dir, "explicit");
      mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(repo, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "explicit-market",
          metadata: { version: "2.0.0" },
          plugins: [{ name: "curated", source: "./", skills: ["./skills/listed"] }],
        }),
      );
      writeSkill(repo, "skills/listed", "listed", "The one the publisher listed.");
      // Present on disk but NOT in the explicit array — the publisher curated
      // the list, so auto-discovery must not add it back.
      writeSkill(repo, "skills/unlisted", "unlisted", "Deliberately excluded.");
      gitCommitAll(repo);

      await addMarketplace(repo);
      const entry = (await listCatalog()).find((m) => m.id === "explicit-market");
      expect(entry!.items.map((i) => i.id)).toEqual(["listed"]);
      expect(entry!.items[0].skill?.version).toBe("2.0.0");
    } finally {
      dispose();
    }
  });

  test("a remote (object) source or a traversal source is skipped, not fatal", async () => {
    const { dir, dispose } = setupTest("anthropic-bad-sources");
    try {
      const repo = join(dir, "mixed");
      mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(repo, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "mixed-market",
          plugins: [
            // Remote plugin source — nothing local to scan; must not throw.
            { name: "remote", source: { source: "github", repo: "acme/skills" } },
            // Hostile source — must never be resolved outside the clone.
            { name: "hostile", source: "../../outside" },
            { name: "good", version: "0.1.0", source: "./" },
          ],
        }),
      );
      writeSkill(repo, "skills/safe", "safe", "The only reachable skill.");
      gitCommitAll(repo);

      await addMarketplace(repo);
      const entry = (await listCatalog()).find((m) => m.id === "mixed-market");
      expect(entry!.items.map((i) => i.id)).toEqual(["safe"]);
    } finally {
      dispose();
    }
  });
});
