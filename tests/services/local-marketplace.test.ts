// The dataDir()/user-apps/ "local marketplace" (user-specs/002-service-daemons):
// user-apps/ is the user's own GitFS repo (the same concept as user-specs/ —
// BOS only ensures it's a git repo, never populates or deletes from it) that's
// auto-scanned and exposed through the same marketplace catalog + install ops
// as a real registered marketplace, under the reserved id LOCAL_MARKETPLACE_ID
// ("user-apps"). No marketplace.json is ever written into it — the catalog is
// computed in memory on every read.
//   npx playwright test -c playwright.unit.config.ts tests/services/local-marketplace.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
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

/** Lays out a user-apps/<id>/ item bundling both a service and an app. */
function layOutServiceAndApp(dataDir: string, id: string): void {
  const itemPath = join(dataDir, "user-apps", id);
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
  test("listCatalog auto-discovers user-apps items with both app and services badges, computed in memory only", async () => {
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
      expect(item.app?.entrypoint).toBe("widget/app");
      expect(item.services?.entrypoint).toBe("widget");

      // user-apps/ is the user's own GitFS repo (same concept as user-specs/)
      // — BOS must never write a generated artifact into it, so no
      // marketplace.json should ever land on disk there.
      const manifestPath = join(dir, "user-apps", "marketplace.json");
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      dispose();
    }
  });

  test("listCatalog omits an item shape that isn't a recognised item type", async () => {
    const { dir, dispose } = setupTest("local-mkt-unrecognised");
    try {
      mkdirSync(join(dir, "user-apps", "not-an-item"), { recursive: true });
      writeFileSync(join(dir, "user-apps", "not-an-item", "README.md"), "just a stray folder");

      const catalog = await listCatalog();
      const local = catalog.find((m) => m.id === LOCAL_MARKETPLACE_ID);
      expect(local?.items).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("installMarketplaceService installs an item directly from user-apps/ without copying it onto itself", async () => {
    const { dir, dispose } = setupTest("local-mkt-install-service");
    try {
      layOutServiceAndApp(dir, "widget");

      const result = await installMarketplaceService(LOCAL_MARKETPLACE_ID, "widget");
      expect(result.serviceId).toBe("widget");
      expect(await isInstalled("widget")).toBe(true);
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
      expect(existsSync(join(dir, "user-apps", "widget"))).toBe(true);
    } finally {
      dispose();
    }
  });
});
