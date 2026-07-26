import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";

// Item-to-system symlink mapping (user-specs/002-service-daemons/spec.md
// §"Item-to-System Symlink Mapping"). Every service item is a self-contained
// folder under dataDir()/user-apps/<id>/ (or a marketplace clone); installing
// it means symlinking its known subdirectories into dataDir()/system/<type>/<id>
// so the rest of BOS can discover it by a stable, type-scoped path.

export interface SymlinkTarget {
  /** Absolute path where the symlink is created. */
  linkPath: string;
  /** Absolute path the symlink points at. */
  targetPath: string;
  /** If false, the source directory is optional — skipped silently when absent. */
  required: boolean;
}

function symlinkTargets(itemPath: string, serviceId: string): SymlinkTarget[] {
  return [
    { linkPath: path.join(dataDir(), "system", "services", serviceId), targetPath: path.join(itemPath, "services"), required: true },
    { linkPath: path.join(dataDir(), "config", serviceId), targetPath: path.join(itemPath, "config"), required: true },
    { linkPath: path.join(dataDir(), "specs", "external-specs", serviceId), targetPath: path.join(itemPath, "spec"), required: false },
    { linkPath: path.join(dataDir(), "docs", "external-docs", serviceId), targetPath: path.join(itemPath, "doc"), required: false },
    { linkPath: path.join(dataDir(), "system", "hooks", serviceId), targetPath: path.join(itemPath, "hooks"), required: false },
    { linkPath: path.join(dataDir(), "system", "app", serviceId), targetPath: path.join(itemPath, "app"), required: false },
  ];
}

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function createOneSymlink(target: SymlinkTarget): Promise<void> {
  const sourceExists = await pathExists(target.targetPath);
  if (!sourceExists) {
    if (target.required) {
      throw new Error(`Cannot create symlink: source directory does not exist: ${target.targetPath}`);
    }
    return;
  }

  try {
    await fs.mkdir(path.dirname(target.linkPath), { recursive: true });
    // Remove a stale link/file at the destination (re-install case) before
    // creating the new one — fs.symlink fails with EEXIST otherwise.
    await fs.rm(target.linkPath, { force: true, recursive: false }).catch(() => {});
    await fs.symlink(target.targetPath, target.linkPath, "dir");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "EACCES" || nodeErr.code === "EPERM") {
      throw new Error(
        `Permission denied creating symlink at "${target.linkPath}" -> "${target.targetPath}". ` +
          `Check filesystem permissions for dataDir() and retry.`,
      );
    }
    throw new Error(`Failed to create symlink at "${target.linkPath}" -> "${target.targetPath}": ${nodeErr.message}`);
  }
}

/** Create the config directory symlink only (used standalone by callers that
 *  just need config wired up before the rest of installation completes). */
export async function createConfigSymlink(itemPath: string, serviceId: string): Promise<void> {
  const target = symlinkTargets(itemPath, serviceId).find((t) => t.linkPath.includes(path.join("config", serviceId)))!;
  await createOneSymlink(target);
}

/** Create the system/app/<id> symlink only — installing an item's app facet
 *  (which needs no services/ or config/, unlike a full service install). */
export async function createAppSymlink(itemPath: string, itemId: string): Promise<void> {
  const target = symlinkTargets(itemPath, itemId).find((t) => t.linkPath === path.join(dataDir(), "system", "app", itemId))!;
  await createOneSymlink({ ...target, required: true });
}

/** Remove the system/app/<id> symlink only (soft app uninstall — the item's
 *  files are untouched). Missing link is ignored. */
export async function removeAppSymlink(itemId: string): Promise<void> {
  await fs.rm(path.join(dataDir(), "system", "app", itemId), { force: true }).catch(() => {});
}

/** Create all applicable symlinks for a service item. Required targets
 *  (services/, config/) must exist in the item or this throws. Optional
 *  targets (spec/, doc/, hooks/, app/) are skipped silently when absent. */
export async function createSymlinks(itemPath: string, serviceId: string): Promise<void> {
  const targets = symlinkTargets(itemPath, serviceId);
  const created: SymlinkTarget[] = [];
  try {
    for (const target of targets) {
      await createOneSymlink(target);
      created.push(target);
    }
  } catch (err) {
    // Roll back any symlinks already created in this call so a failed
    // install doesn't leave a half-installed service behind.
    for (const target of created) {
      await fs.rm(target.linkPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

/** Remove every symlink that createSymlinks may have created for this id.
 *  Missing links are ignored — uninstall is idempotent. */
export async function removeSymlinks(serviceId: string): Promise<void> {
  const links = [
    path.join(dataDir(), "system", "services", serviceId),
    path.join(dataDir(), "config", serviceId),
    path.join(dataDir(), "specs", "external-specs", serviceId),
    path.join(dataDir(), "docs", "external-docs", serviceId),
    path.join(dataDir(), "system", "hooks", serviceId),
    path.join(dataDir(), "system", "app", serviceId),
  ];
  for (const linkPath of links) {
    try {
      await fs.rm(linkPath, { force: true });
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "EACCES" || nodeErr.code === "EPERM") {
        throw new Error(`Permission denied removing symlink at "${linkPath}". Check filesystem permissions for dataDir() and retry.`);
      }
      throw new Error(`Failed to remove symlink at "${linkPath}": ${nodeErr.message}`);
    }
  }
}

/** True if the service's required "system/services/<id>" symlink exists —
 *  the definition of "installed" per the spec's source/installed split. */
export async function isInstalled(serviceId: string): Promise<boolean> {
  return pathExists(path.join(dataDir(), "system", "services", serviceId));
}
