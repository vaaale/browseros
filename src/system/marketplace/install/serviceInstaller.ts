import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging";
import { createSymlinks, removeSymlinks } from "./symlinkManager";
import { validateManifest } from "@/core/service/manifestValidator";
import { serviceRegistry } from "@/core/service/ServiceRegistry";
import type { ServiceManifest } from "@/core/service/types";

const COMPONENT = "services.installer";

async function readServiceManifest(installedServicesDir: string): Promise<ServiceManifest> {
  const manifestPath = path.join(installedServicesDir, "service.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw) as ServiceManifest;
}

/**
 * Install a service item: create the dataDir()/system/ + dataDir()/config/
 * symlinks, validate the now-symlinked manifest, register it in the registry,
 * and notify the Settings UI. Installation is atomic — any failure after
 * symlink creation rolls the symlinks back so a bad install never lingers.
 *
 * `itemPath` must already exist (e.g. dataDir()/user-apps/<id>/ or a
 * marketplace clone under dataDir()/marketplace/<mktId>/items/<id>/) —
 * cloning/copying the item there is the caller's responsibility (Step 1 of
 * the install flow), same division of labor as installServerPlugin/installApp.
 */
export async function installService(itemPath: string, serviceId?: string): Promise<ServiceManifest> {
  const id = serviceId ?? path.basename(itemPath);
  const registry = serviceRegistry();

  await createSymlinks(itemPath, id);

  try {
    const installedServicesDir = path.join(dataDir(), "system", "services", id);
    const manifest = await readServiceManifest(installedServicesDir);
    if (manifest.id !== id) {
      throw new Error(`service.json id "${manifest.id}" does not match item id "${id}"`);
    }

    const result = await validateManifest(manifest, installedServicesDir);
    if (!result.valid) {
      throw new Error(`Invalid service manifest for "${id}": ${result.errors.join("; ")}`);
    }

    registry.registerInstalled(id, manifest, itemPath);
    registry.emit({ type: "service:installed", id });
    logger().info(COMPONENT, "service.installed", { id, itemPath });
    return manifest;
  } catch (err) {
    await removeSymlinks(id).catch(() => {});
    logger().error(COMPONENT, "service.install-failed", err, { id, itemPath });
    throw err;
  }
}

/**
 * Uninstall a service: stop it if running, remove all symlinks, and drop it
 * from the registry. This NEVER touches the item's source directory —
 * dataDir()/user-apps/ is the user's own GitFS repo (the same concept as
 * user-specs/), and install/uninstall only ever create/remove symlinks into
 * it, exactly like adopting/discarding a spec never deletes the user's spec
 * store. A marketplace clone the item may have come from is equally left
 * untouched — uninstalling only ever removes the symlinks this service's
 * install created.
 */
export async function uninstallService(serviceId: string): Promise<void> {
  const registry = serviceRegistry();

  const { serviceManager } = await import("@/core/service/ServiceManager");
  const manager = serviceManager();
  const status = manager.getStatus(serviceId);
  if (status === "running" || status === "restarting") {
    await manager.stop(serviceId);
  }

  await removeSymlinks(serviceId);
  registry.unregisterInstalled(serviceId);
  registry.emit({ type: "service:uninstalled", id: serviceId });

  logger().info(COMPONENT, "service.uninstalled", { id: serviceId });
}
