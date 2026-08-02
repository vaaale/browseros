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
  installMarketplaceService,
  LOCAL_MARKETPLACE_ID,
} from "../../src/lib/marketplace/client";
import { isInstalled } from "../../src/system/marketplace/install/symlinkManager";
import { useTestDataDir, resetServiceSingletons } from "./_test-env";
import { RESPONSIVE_WORKER } from "./_worker-fixtures";

function setupTest(label: string) {
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
