// Integration tests for the install/uninstall flow (T046): symlink creation
// (including rollback on a bad manifest), manifest validation, and registry
// update — end to end through the REAL installItemLink/installService/
// uninstallService functions, not the registry's registerInstalled() shortcut
// the other unit tests use. Real fs under a temp BOS_DATA_DIR, real worker
// fixtures, no module mocking — same conventions as ServiceManager.test.ts /
// ServiceRegistry.test.ts.
//   npx playwright test -c playwright.unit.config.ts tests/services/integration.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, lstatSync } from "fs";
import { installService, uninstallService } from "../../src/system/marketplace/install/serviceInstaller";
import { isInstalled } from "../../src/system/marketplace/install/symlinkManager";
import { serviceRegistry } from "../../src/core/service/ServiceRegistry";
import { ServiceManager } from "../../src/core/service/ServiceManager";
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

/** Lays out a full user-apps/items/<id>/ item (services/ + config/) — the shape
 *  installService() expects `itemPath` to already be in. Nothing is copied on
 *  install; the item stays here and is symlinked from system/<id> (035). */
function layOutItem(dataDir: string, id: string, opts: { entrySource?: string; withApp?: boolean } = {}): string {
  const itemPath = join(dataDir, "user-apps", "items", id);
  const servicesDir = join(itemPath, "services");
  const configDir = join(itemPath, "config");
  mkdirSync(servicesDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(servicesDir, "service.json"), JSON.stringify({ id, name: id, version: "1.0.0", entry: "index.js" }));
  writeFileSync(join(servicesDir, "index.js"), opts.entrySource ?? RESPONSIVE_WORKER);
  writeFileSync(join(configDir, `${id}.json`), JSON.stringify({ port: 0 }));
  if (opts.withApp) {
    mkdirSync(join(itemPath, "app"), { recursive: true });
    writeFileSync(join(itemPath, "app", "index.html"), "<!doctype html><title>test app</title>");
  }
  return itemPath;
}

test.describe("installService", () => {
  test("creates ONE item symlink, seeds config, validates the manifest, registers the service", async () => {
    const { dir, dispose } = setupTest("integration-install-basic");
    try {
      const itemPath = layOutItem(dir, "svc");

      const manifest = await installService(itemPath, "svc");

      expect(manifest.id).toBe("svc");
      expect(await isInstalled("svc")).toBe(true);

      // Installed state is exactly one symlink at system/<id> (035 FR-002) —
      // no per-facet farm, and the manifest resolves THROUGH it.
      expect(lstatSync(join(dir, "system", "svc")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(dir, "system", "svc", "services", "service.json"))).toBe(true);
      expect(existsSync(join(dir, "system", "services"))).toBe(false);

      // Config is seeded as a REAL BOS-owned directory, not a link into the item
      // (035 FR-004) — a service writes runtime.json there.
      const configDir = join(dir, "system", "config", "svc");
      expect(lstatSync(configDir).isSymbolicLink()).toBe(false);
      expect(existsSync(join(configDir, "svc.json"))).toBe(true);

      const registered = serviceRegistry().getService("svc");
      expect(registered?.installed).toBe(true);
      // installService() autostarts what it installed, and now that the
      // entrypoint resolves through the item link it actually reaches "running".
      // Previously this asserted "stopped" — which only held because the
      // pre-035 path could not resolve the entry at all.
      expect(registered?.state).toBe("running");
      await uninstallService("svc");
    } finally {
      dispose();
    }
  });

  test("an app facet is reachable through the item link; an item without one has none", async () => {
    const { dir, dispose } = setupTest("integration-install-optional-app");
    try {
      const withApp = layOutItem(dir, "svc-with-app", { withApp: true });
      await installService(withApp, "svc-with-app");
      // Reached through the single item link rather than a system/app/<id> link.
      expect(existsSync(join(dir, "system", "svc-with-app", "app", "index.html"))).toBe(true);

      const withoutApp = layOutItem(dir, "svc-without-app");
      await installService(withoutApp, "svc-without-app");
      expect(existsSync(join(dir, "system", "svc-without-app", "app"))).toBe(false);
    } finally {
      dispose();
    }
  });

  test("rolls back every symlink it created when the manifest is invalid", async () => {
    const { dir, dispose } = setupTest("integration-install-rollback");
    try {
      const itemPath = layOutItem(dir, "bad-svc");
      // Overwrite with a manifest missing required fields (no `entry`).
      writeFileSync(join(itemPath, "services", "service.json"), JSON.stringify({ id: "bad-svc", name: "bad-svc" }));

      await expect(installService(itemPath, "bad-svc")).rejects.toThrow(/invalid service manifest/i);

      // Nothing should be left behind — install is atomic.
      expect(await isInstalled("bad-svc")).toBe(false);
      expect(existsSync(join(dir, "config", "bad-svc"))).toBe(false);
      expect(serviceRegistry().getService("bad-svc")).toBeUndefined();
    } finally {
      dispose();
    }
  });

  test("rejects when service.json's id does not match the item's directory name", async () => {
    const { dir, dispose } = setupTest("integration-install-id-mismatch");
    try {
      const itemPath = layOutItem(dir, "actual-id");
      await expect(installService(itemPath, "wrong-id")).rejects.toThrow(/does not match/i);
      expect(await isInstalled("wrong-id")).toBe(false);
    } finally {
      dispose();
    }
  });
});

test.describe("uninstallService", () => {
  test("stops a running service, removes symlinks, and unregisters it — never touches the item's source", async () => {
    const { dir, dispose } = setupTest("integration-uninstall-running");
    try {
      const itemPath = layOutItem(dir, "svc");
      await installService(itemPath, "svc");

      const manager = new ServiceManager();
      await manager.start("svc", { startupTimeout: 5_000 });
      expect(serviceRegistry().getService("svc")?.state).toBe("running");

      await uninstallService("svc");

      expect(await isInstalled("svc")).toBe(false);
      expect(existsSync(join(dir, "config", "svc"))).toBe(false);
      expect(serviceRegistry().getService("svc")).toBeUndefined();
      // user-apps/ is the user's own GitFS repo (same concept as user-specs/)
      // — install/uninstall only ever create/remove symlinks into it, never
      // touch the source (user-specs/002-service-daemons's revised model).
      expect(existsSync(itemPath)).toBe(true);
    } finally {
      dispose();
    }
  });

  test("uninstalling an already-stopped service is a clean no-op stop, item source untouched", async () => {
    const { dir, dispose } = setupTest("integration-uninstall-stopped");
    try {
      const itemPath = layOutItem(dir, "svc");
      await installService(itemPath, "svc");

      await uninstallService("svc");

      expect(await isInstalled("svc")).toBe(false);
      expect(existsSync(itemPath)).toBe(true);
    } finally {
      dispose();
    }
  });

  test("does not remove a marketplace clone the item was installed directly from", async () => {
    const { dir, dispose } = setupTest("integration-uninstall-marketplace-source-preserved");
    try {
      // Simulate a marketplace-sourced install: install directly from a
      // "marketplace clone" path (outside user-apps/) to verify uninstall
      // never removes the item's source, regardless of where it lives.
      const marketplaceClone = join(dir, "marketplace", "mkt", "svc-source");
      mkdirSync(join(marketplaceClone, "services"), { recursive: true });
      mkdirSync(join(marketplaceClone, "config"), { recursive: true });
      writeFileSync(join(marketplaceClone, "services", "service.json"), JSON.stringify({ id: "svc", name: "svc", version: "1.0.0", entry: "index.js" }));
      writeFileSync(join(marketplaceClone, "services", "index.js"), RESPONSIVE_WORKER);

      await installService(marketplaceClone, "svc");
      await uninstallService("svc");

      expect(existsSync(marketplaceClone)).toBe(true);
    } finally {
      dispose();
    }
  });
});

test.describe("full lifecycle: install → start → stop → uninstall", () => {
  test("a service installed via the real symlink flow can be started and stopped through ServiceManager", async () => {
    const { dir, dispose } = setupTest("integration-full-lifecycle");
    try {
      const itemPath = layOutItem(dir, "svc");
      await installService(itemPath, "svc");

      const manager = new ServiceManager();
      await manager.start("svc", { startupTimeout: 5_000 });
      expect(manager.getStatus("svc")).toBe("running");

      await manager.stop("svc");
      expect(manager.getStatus("svc")).toBe("stopped");

      await uninstallService("svc");
      expect(await isInstalled("svc")).toBe(false);
    } finally {
      dispose();
    }
  });
});
