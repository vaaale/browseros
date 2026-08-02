import "server-only";
import { promises as fs } from "fs";
import path from "path";
import Ajv from "ajv";
import type { ServiceManifest } from "./types";

const ID_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validate a service.json manifest structurally: required fields, configSchema
 * shape, and self-dependency rejection. Does NOT touch the filesystem beyond
 * checking the entrypoint exists (itemDir must be supplied for that check).
 */
export async function validateManifest(manifest: unknown, itemDir?: string): Promise<ValidationResult> {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["service.json is not an object"] };
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.id !== "string" || !m.id.trim()) {
    errors.push("manifest.id is required and must be a non-empty string");
  } else if (!ID_RE.test(m.id)) {
    errors.push("manifest.id must be lowercase alphanumeric with optional dots, hyphens, or underscores");
  }

  if (typeof m.name !== "string" || !m.name.trim()) {
    errors.push("manifest.name is required and must be a non-empty string");
  }

  if (typeof m.version !== "string" || !m.version.trim()) {
    errors.push("manifest.version is required and must be a semver string");
  }

  if (typeof m.entry !== "string" || !m.entry.trim()) {
    errors.push("manifest.entry is required and must be a string path");
  }

  if (m.configSchema !== undefined) {
    if (typeof m.configSchema !== "object" || m.configSchema === null) {
      errors.push("manifest.configSchema must be an object if provided");
    } else {
      try {
        ajv.compile(m.configSchema as Record<string, unknown>);
      } catch (err) {
        errors.push(`manifest.configSchema is not valid JSON Schema: ${(err as Error).message}`);
      }
    }
  }

  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies) || m.dependencies.some((d) => typeof d !== "string")) {
      errors.push("manifest.dependencies must be an array of service id strings");
    } else if (typeof m.id === "string" && (m.dependencies as string[]).includes(m.id)) {
      errors.push(`manifest.dependencies must not include the service's own id ("${m.id}") — self-dependencies are rejected`);
    }
  }

  if (m.settingsRegistration !== undefined) {
    if (typeof m.settingsRegistration !== "object" || m.settingsRegistration === null) {
      errors.push("manifest.settingsRegistration must be an object if provided");
    } else {
      const sr = m.settingsRegistration as Record<string, unknown>;
      if (typeof sr.label !== "string" || !sr.label.trim()) {
        errors.push("manifest.settingsRegistration.label is required");
      }
    }
  }

  if (errors.length === 0 && itemDir && typeof m.entry === "string") {
    const entryPath = path.resolve(itemDir, m.entry);
    const exists = await fs.access(entryPath).then(() => true).catch(() => false);
    if (!exists) {
      errors.push(`manifest.entry does not exist: ${entryPath}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Convenience wrapper: parse + validate a service.json file's raw content. */
export async function validateServiceJson(content: string, itemDir?: string): Promise<ValidationResult> {
  try {
    const parsed = JSON.parse(content);
    return validateManifest(parsed, itemDir);
  } catch (err) {
    return { valid: false, errors: [`invalid JSON: ${(err as Error).message}`] };
  }
}

/**
 * At-start validation (CH-011): the entrypoint must actually be require()-able,
 * not just present on disk. Catches syntax errors / missing dependencies before
 * a worker thread is spun up. Does not execute module top-level side effects
 * beyond what require() itself triggers (CommonJS), and never throws — callers
 * get a clear pass/fail plus the caught error message.
 */
/**
 * `serviceDirPath` is the service's OWN directory — `dataDir()/system/<id>/services`
 * under 035, where installed state is one symlink per item. It used to be the
 * shared `system/services` root with the id joined on, which no longer exists.
 */
export async function validateManifestAtStart(manifest: ServiceManifest, serviceDirPath: string): Promise<ValidationResult> {
  const entryPath = path.resolve(serviceDirPath, manifest.entry);
  try {
    const exists = await fs.access(entryPath).then(() => true).catch(() => false);
    if (!exists) {
      return { valid: false, errors: [`entrypoint not found: ${entryPath}`] };
    }
    // Dynamic import with webpackIgnore mirrors src/lib/plugins/loader.ts's
    // loadPluginFromDir — without the comment, Turbopack/webpack try (and fail)
    // to statically resolve this variable path at build time. This actually
    // loads the module (not just a syntax check) to catch missing deps too;
    // worker entrypoints only touch parentPort inside their message handlers,
    // so importing them from the main thread is safe (parentPort is just null).
    await import(/* webpackIgnore: true */ entryPath);
    return { valid: true, errors: [] };
  } catch (err) {
    return { valid: false, errors: [`entrypoint failed to load: ${(err as Error).message}`] };
  }
}
