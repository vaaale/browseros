// dataDir()/user-apps/ is the user's own PRIVATE MARKETPLACE — structurally
// identical to any registered clone: a root marketplace.json plus items under
// items/<id>/ (034-user-apps-marketplace-parity). It occupies the slot keyed by
// LOCAL_MARKETPLACE_ID ("user-apps"), and BOS MAINTAINS its manifest by merge
// (add discovered items, prune vanished ones, never touch authored fields).
// Installing copies nothing — one symlink at dataDir()/system/<id> (035).
//   npx playwright test -c playwright.unit.config.ts tests/services/local-marketplace.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, realpathSync } from "fs";
import { execFileSync } from "child_process";
import {
  listCatalog,
  addMarketplace,
  removeMarketplace,
  syncMarketplace,
  installMarketplaceService,
  LOCAL_MARKETPLACE_ID,
} from "../../src/lib/marketplace/client";
import { isInstalled } from "../../src/system/marketplace/install/symlinkManager";
import { useTestDataDir, resetServiceSingletons } from "./_test-env";
import { RESPONSIVE_WORKER } from "./_worker-fixtures";

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

/** Lays out a user-apps/items/<id>/ item bundling both a service and an app. */
function layOutServiceAndApp(dataDir: string, id: string): void {
  const itemPath = join(dataDir, "user-apps", "items", id);
  mkdirSync(join(itemPath, "services"), { recursive: true });
  mkdirSync(join(itemPath, "config"), { recursive: true });
  mkdirSync(join(itemPath, "app"), { recursive: true });
  writeFileSync(
    join(itemPath, "services", "service.json"),
    JSON.stringify({ id, name: `${id} Service`, version: "1.0.0", description: "test item", entry: "index.js" }),
  );
  writeFileSync(join(itemPath, "services", "index.js"), RESPONSIVE_WORKER);
  writeFileSync(join(itemPath, "config", `${id}.json`), JSON.stringify({ port: 0 }));
  writeFileSync(join(itemPath, "app", "index.html"), "<!doctype html><title>test app</title>");
}

test.describe("local marketplace (dataDir()/user-apps/)", () => {
  test("listCatalog auto-discovers items under items/ and writes the manifest BOS maintains", async () => {
    const { dir, dispose } = setupTest("local-mkt-catalog");
    try {
      layOutServiceAndApp(dir, "widget");

      const catalog = await listCatalog();
      const local = catalog.find((m) => m.id === LOCAL_MARKETPLACE_ID);
      expect(local).toBeDefined();
      expect(local?.items).toHaveLength(1);
      const item = local!.items[0];
      expect(item.id).toBe("widget");
      expect(item.name).toBe("widget Service");
      // Entrypoints are repo-relative, so they carry the items/ prefix — the same
      // shape a registered marketplace's manifest uses.
      expect(item.app?.entrypoint).toBe("items/widget/app");
      expect(item.services?.entrypoint).toBe("items/widget");

      // BOS maintains this repo's marketplace.json (034 FR-002/FR-003), which is
      // the reverse of the old rule that it must never write here.
      const manifestPath = join(dir, "user-apps", "marketplace.json");
      expect(existsSync(manifestPath)).toBe(true);
      const written = JSON.parse(readFileSync(manifestPath, "utf8")) as { items: { id: string }[] };
      expect(written.items.map((i) => i.id)).toEqual(["widget"]);
    } finally {
      dispose();
    }
  });

  test("reconciliation is a no-op when nothing changed — a catalog read must not dirty the repo", async () => {
    const { dir, dispose } = setupTest("local-mkt-idempotent");
    try {
      layOutServiceAndApp(dir, "widget");
      await listCatalog();
      const manifestPath = join(dir, "user-apps", "marketplace.json");
      const first = readFileSync(manifestPath, "utf8");

      await listCatalog();
      expect(readFileSync(manifestPath, "utf8")).toBe(first);
    } finally {
      dispose();
    }
  });

  test("a removed item directory is pruned from the manifest", async () => {
    const { dir, dispose } = setupTest("local-mkt-prune");
    try {
      layOutServiceAndApp(dir, "widget");
      await listCatalog();
      rmSync(join(dir, "user-apps", "items", "widget"), { recursive: true, force: true });

      const catalog = await listCatalog();
      expect(catalog.find((m) => m.id === LOCAL_MARKETPLACE_ID)?.items).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("listCatalog omits an item shape that isn't a recognised item type", async () => {
    const { dir, dispose } = setupTest("local-mkt-unrecognised");
    try {
      mkdirSync(join(dir, "user-apps", "items", "not-an-item"), { recursive: true });
      writeFileSync(join(dir, "user-apps", "items", "not-an-item", "README.md"), "just a stray folder");

      const catalog = await listCatalog();
      const local = catalog.find((m) => m.id === LOCAL_MARKETPLACE_ID);
      expect(local?.items).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("installing from the local marketplace creates one symlink and copies nothing", async () => {
    const { dir, dispose } = setupTest("local-mkt-install-service");
    try {
      layOutServiceAndApp(dir, "widget");

      const result = await installMarketplaceService(LOCAL_MARKETPLACE_ID, "widget");
      expect(result.serviceId).toBe("widget");
      expect(await isInstalled("widget")).toBe(true);

      // Installed state is ONE symlink pointing at the item where it already
      // lives — no copy, and no per-facet link farm (035 FR-002).
      const link = join(dir, "system", "widget");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(dir, "user-apps", "items", "widget")));
      expect(existsSync(join(dir, "system", "services"))).toBe(false);
      expect(existsSync(join(dir, "system", "app"))).toBe(false);

      // Config is seeded as BOS-owned state, not linked into the item (035 FR-004).
      const seeded = join(dir, "system", "config", "widget", "widget.json");
      expect(existsSync(seeded)).toBe(true);
      expect(lstatSync(join(dir, "system", "config", "widget")).isSymbolicLink()).toBe(false);
    } finally {
      dispose();
    }
  });

  test("addMarketplace rejects a real marketplace that claims the reserved local-marketplace id", async () => {
    const { dir, dispose } = setupTest("local-mkt-reserved-add");
    try {
      // A real local git repo (allowed as a marketplace URL outside production)
      // whose marketplace.json claims id "user-apps" — the reserved id must be
      // rejected even for an otherwise-valid, reachable marketplace.
      const repoDir = join(dir, "fake-remote");
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(
        join(repoDir, "marketplace.json"),
        JSON.stringify({ id: LOCAL_MARKETPLACE_ID, name: "Impostor", version: "1.0.0", items: [] }),
      );
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "add", "-A"], { cwd: repoDir });
      execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repoDir });

      await expect(addMarketplace(repoDir)).rejects.toThrow(/reserved marketplace id/i);
    } finally {
      dispose();
    }
  });

  test("removeMarketplace on the local marketplace never touches user-apps/ on disk", async () => {
    const { dir, dispose } = setupTest("local-mkt-remove-noop");
    try {
      layOutServiceAndApp(dir, "widget");
      await expect(removeMarketplace(LOCAL_MARKETPLACE_ID)).rejects.toThrow();
      expect(existsSync(join(dir, "user-apps", "items", "widget"))).toBe(true);
    } finally {
      dispose();
    }
  });
});

test("top-level skills/ in user-apps are catalogued as skill items (034 parity)", async () => {
  const { dir, cleanup } = useTestDataDir("local-mkt-skills");
  try {
    // 034 says user-apps has the same layout as any marketplace clone, and a
    // CLONE's skills are catalogued. The local scan only walked items/, so a
    // skill sitting in user-apps/skills/ was git-tracked, present on disk, and
    // completely invisible in the Marketplace — uninstallable from it.
    const skillDir = join(dir, "user-apps", "skills", "gws-gmail");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ['---', 'name: gws-gmail', 'description: "Gmail: Send, read, and manage email."', "metadata:", "  version: 0.22.5", '---', "# Body"].join("\n"),
    );
    // A folder without SKILL.md is not installable, so it must not be offered.
    mkdirSync(join(dir, "user-apps", "skills", "not-a-skill"), { recursive: true });

    const catalog = await listCatalog();
    const local = catalog.find((m) => m.items.some((i) => i.id === "gws-gmail"));
    expect(local, "the local marketplace should offer the skill").toBeTruthy();

    const item = local!.items.find((i) => i.id === "gws-gmail")!;
    expect(item.skill?.path).toBe("skills/gws-gmail");
    expect(item.skill?.version).toBe("0.22.5"); // read from the nested metadata block
    expect(item.name).toBe("gws-gmail");
    expect(item.description).toContain("Gmail");

    expect(local!.items.some((i) => i.id === "not-a-skill")).toBe(false);
  } finally {
    cleanup();
  }
});

test("a curated entry the local scanner can never re-emit is NOT pruned while its files exist", async () => {
  const { dir, cleanup } = useTestDataDir("local-mkt-no-prune");
  try {
    // Regression for a real data loss: on 2026-08-25 BOS committed "sync
    // marketplace manifest (21 removed)" against the user's own repo, deleting
    // all 21 curated skill entries. The prune rule was "keep only ids the
    // scanner rediscovered", and the scanner walks items/ only — so curation
    // for anything it cannot produce was destroyed. 034 FR-004: merge only.
    //
    // The fixture is chosen so the scanners CANNOT put the entry back, which is
    // what actually isolates the prune: `items/my-integration/` holds no app,
    // spec, services or plugin, so scanLocalItems skips it as an unrecognised
    // shape, and it is not under `skills/` so scanLocalSkills never sees it. If
    // the prune drops it, it is gone for good.
    const ua = join(dir, "user-apps");
    mkdirSync(join(ua, "items", "my-integration"), { recursive: true });
    writeFileSync(join(ua, "items", "my-integration", "README.md"), "# not a recognised shape\n");
    writeFileSync(
      join(ua, "marketplace.json"),
      JSON.stringify({
        id: "user-apps", name: "Mine", version: "1.0.0",
        items: [
          { id: "my-integration", name: "My Integration", description: "d", integration: { entrypoint: "items/my-integration", version: "1.0.0" } },
          { id: "ghost", name: "Ghost", description: "d", skill: { path: "skills/ghost", version: "1.0.0" } },
        ],
      }, null, 2) + "\n",
    );

    await listCatalog();
    const after = JSON.parse(readFileSync(join(ua, "marketplace.json"), "utf8")) as { items: { id: string }[] };
    const ids = after.items.map((i) => i.id);

    expect(ids, "curation the scanner cannot re-emit must survive").toContain("my-integration");
    // ...but an entry whose files are genuinely gone still goes: the manifest
    // must never advertise something that cannot be installed.
    expect(ids, "entry with no surviving facet should be pruned").not.toContain("ghost");
  } finally {
    cleanup();
  }
});

test("a registered marketplace stops advertising an item whose folder was deleted upstream, after sync", async () => {
  const { dir, cleanup } = useTestDataDir("remote-mkt-stale-prune");
  try {
    // Regression: syncMarketplace only fast-forwards the clone (git pull) and
    // trusts whatever marketplace.json comes with it — it never cross-checks
    // declared facet paths against what actually exists in the clone. If the
    // publisher deletes an item's folder but a stale entry lingers in
    // marketplace.json (their own manifest-maintenance bug, not BOS's clone),
    // BOS kept serving it forever, through every future sync, because nothing
    // downstream of the pull ever verified the facet still exists on disk.
    const commit = (cwd: string, msg: string) => {
      execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "add", "-A"], { cwd });
      execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", msg], { cwd });
    };
    const writeManifest = (cwd: string, items: unknown[]) =>
      writeFileSync(join(cwd, "marketplace.json"), JSON.stringify({ id: "acme", name: "Acme", version: "1.0.0", items }, null, 2) + "\n");

    const upstream = join(dir, "upstream");
    mkdirSync(join(upstream, "items", "welcome", "app"), { recursive: true });
    writeFileSync(join(upstream, "items", "welcome", "app", "index.html"), "<!doctype html><title>welcome</title>");
    writeManifest(upstream, [
      { id: "welcome", name: "Welcome", description: "d", app: { entrypoint: "items/welcome/app", runtime: "iframe", version: "1.0.0" } },
    ]);
    execFileSync("git", ["init", "-q"], { cwd: upstream });
    commit(upstream, "init");

    const reg = await addMarketplace(upstream);
    const before = await listCatalog();
    expect(before.find((m) => m.id === reg.id)?.items.map((i) => i.id)).toContain("welcome");

    // Publisher deletes the app's folder but the manifest entry for it lingers
    // (their bug, not this clone's) — the exact shape of the reported bug.
    rmSync(join(upstream, "items", "welcome"), { recursive: true, force: true });
    commit(upstream, "remove welcome app files (manifest entry left behind)");

    await syncMarketplace(reg.id);
    const after = await listCatalog();
    const entry = after.find((m) => m.id === reg.id);
    expect(entry?.items.map((i) => i.id), "stale entry must not survive a sync").not.toContain("welcome");

    // And the fix must never rewrite/commit into someone else's repo clone.
    const cloneManifest = JSON.parse(readFileSync(join(dir, "marketplace", reg.id, "marketplace.json"), "utf8")) as { items: { id: string }[] };
    expect(cloneManifest.items.map((i) => i.id), "the clone's own marketplace.json is read-only to BOS").toContain("welcome");
  } finally {
    cleanup();
  }
});
