import "server-only";
import path from "path";
import { logger } from "@/lib/logging";
import { installItemLink, uninstallItemLink } from "./symlinkManager";
import { itemLinkPath } from "@/system/items/installed";
import { validateManifest, readServiceManifest } from "@/core/service/manifestValidator";
import { serviceRegistry } from "@/core/service/ServiceRegistry";
import { serviceToolBridge } from "@/lib/agent/service-tool-bridge";
import type { ServiceManifest } from "@/core/service/types";

const COMPONENT = "services.installer";

/**
 * Install a service item: create the single dataDir()/system/<id> symlink (which
 * also seeds dataDir()/system/config/<id>), validate the manifest through it,
 * register the service, and notify the Settings UI. Atomic — any failure after
 * the symlink rolls it back so a bad install never lingers.
 *
 * `itemPath` is the item's real location — a marketplace clone under
 * dataDir()/marketplace/<mktId>/items/<id>/, or dataDir()/user-apps/items/<id>/.
 * It is NEVER copied (035 FR-001); the symlink points straight at it.
 */
export async function installService(itemPath: string, serviceId?: string): Promise<ServiceManifest> {
  const id = serviceId ?? path.basename(itemPath);
  const registry = serviceRegistry();

  await installItemLink(itemPath, id);

  try {
    // Read the manifest THROUGH the install symlink, so what we validate is
    // exactly what the rest of BOS will resolve.
    const installedServicesDir = path.join(itemLinkPath(id), "services");
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

    // Auto-start the freshly installed service. Failures here are logged but
    // do NOT roll back the install — same per-service tolerance startAll()
    // applies at boot (CH-007). A crash-looping service stays registered so
    // the user can inspect logs / edit config from Settings.
    try {
      const { serviceManager } = await import("@/core/service/ServiceManager");
      await serviceManager().start(id);
    } catch (err) {
      logger().warn(COMPONENT, "service.autostart-failed", { id, error: (err as Error).message });
    }

    return manifest;
  } catch (err) {
    await uninstallItemLink(id).catch(() => {});
    logger().error(COMPONENT, "service.install-failed", err, { id, itemPath });
    throw err;
  }
}

/**
 * Uninstall a service: stop it if running, remove the one symlink, drop it from
 * the registry. This NEVER touches the item's source, whether that is the user's
 * own repo or a marketplace clone, and it deliberately KEEPS
 * dataDir()/system/config/<id>/ so a reinstall preserves the user's settings
 * (035 FR-003/FR-004).
 */
export async function uninstallService(serviceId: string): Promise<void> {
  const registry = serviceRegistry();

  const { serviceManager } = await import("@/core/service/ServiceManager");
  const manager = serviceManager();
  const status = manager.getStatus(serviceId);
  if (status === "running" || status === "restarting") {
    await manager.stop(serviceId);
  }

  await uninstallItemLink(serviceId);
  registry.unregisterInstalled(serviceId);
  // 039-service-tool-exposure: belt-and-suspenders — stop() above already
  // unregisters a running service's tools, but this covers uninstalling an
  // already-stopped service (which stop() never touches) so no stale tool
  // ever survives an uninstall (FR-006). No-op if the service had none.
  serviceToolBridge().unregisterServiceTools(serviceId);
  registry.emit({ type: "service:uninstalled", id: serviceId });

  logger().info(COMPONENT, "service.uninstalled", { id: serviceId });
}
