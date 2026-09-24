import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import Ajv from "ajv";
import type { ServiceManifest } from "./types";

const ID_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
// 039-service-tool-exposure ADR-002 — absent ⇒ "default" (no tools, backward
// compatible); "tools" opts a service into declaring tools via tool_declare.
const VALID_DEPLOYMENT_MODES = new Set(["default", "tools"]);

/** Read a service manifest from an item's `services/` directory.
 *
 *  Lives here, beside validateManifest, rather than in the installer: a caller
 *  that only wants to VALIDATE a manifest — e.g. a branch-targeted install,
 *  which deliberately does not register or start the service — must not have to
 *  load the installer and with it the service registry, the symlink manager and
 *  the tool bridge. */
export async function readServiceManifest(installedServicesDir: string): Promise<ServiceManifest> {
  const raw = await fs.readFile(path.join(installedServicesDir, "service.json"), "utf8");
  return JSON.parse(raw) as ServiceManifest;
}

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

  if (m.deploymentMode !== undefined && !VALID_DEPLOYMENT_MODES.has(m.deploymentMode as string)) {
    errors.push(`manifest.deploymentMode must be one of "default" | "tools" if provided (got ${JSON.stringify(m.deploymentMode)})`);
  }

  // 041-tool-groups: a tool-exposing item MUST name the group(s) its tools
  // appear under. Validated here so a malformed or missing declaration fails at
  // INSTALL rather than at first service start, and so the failure names the
  // field. There is deliberately no fallback group to absorb this (FR-041).
  if (m.deploymentMode === "tools") {
    const groups = m.toolGroups;
    if (!Array.isArray(groups) || groups.length === 0) {
      errors.push(
        'manifest.toolGroups is required when deploymentMode is "tools": declare the group(s) your tools appear under, e.g. [{ "id": "workflows", "name": "Workflows", "description": "…" }]',
      );
    } else {
      const seen = new Set<string>();
      groups.forEach((raw, i) => {
        const g = raw as Record<string, unknown>;
        if (typeof g?.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(g.id)) {
          errors.push(`manifest.toolGroups[${i}].id must be a lowercase slug (got ${JSON.stringify(g?.id)})`);
        } else if (seen.has(g.id)) {
          errors.push(`manifest.toolGroups[${i}].id "${g.id}" is declared more than once`);
        } else {
          seen.add(g.id);
        }
        if (typeof g?.name !== "string" || !g.name.trim()) {
          errors.push(`manifest.toolGroups[${i}].name is required`);
        }
        if (typeof g?.description !== "string" || !g.description.trim()) {
          errors.push(
            `manifest.toolGroups[${i}].description is required — it is what the assistant reads to decide whether this group is relevant`,
          );
        }
        if (g?.aliases !== undefined && (!Array.isArray(g.aliases) || g.aliases.some((a) => typeof a !== "string"))) {
          errors.push(`manifest.toolGroups[${i}].aliases must be an array of strings if provided`);
        }
      });
    }
  } else if (m.toolGroups !== undefined) {
    errors.push('manifest.toolGroups is only meaningful with deploymentMode "tools"');
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

/** How long the isolated load check may take before the child is killed and the
 *  entry reported as failing to load. Generous: it only has to require/import
 *  the module graph, not run the service. */
const LOAD_CHECK_TIMEOUT_MS = 15_000;

// Runs in a throwaway `node -e` child: argv[1] is the entry path. Dynamic
// import() (via a file URL) loads both CJS and ESM entries, matching what the
// old in-process check accepted. Exit 0 = loaded; exit 1 + stderr = load error.
const LOAD_CHECK_SCRIPT =
  'import(require("node:url").pathToFileURL(process.argv[1]).href)' +
  ".then(() => process.exit(0), (err) => { console.error((err && (err.stack || err.message)) || String(err)); process.exit(1); });";

/**
 * At-start validation (CH-011): the entrypoint must actually be loadable, not
 * just present on disk. Catches syntax errors / missing dependencies before a
 * worker thread is spun up. Never throws — callers get a clear pass/fail plus
 * the load error.
 *
 * The load check runs in a DISPOSABLE CHILD PROCESS, never in the server
 * process. It used to `await import(entryPath)` right here, on the assumption
 * that worker entrypoints only touch parentPort inside their message handlers
 * — an assumption BOS cannot enforce on installed items, whose entry code is
 * not BOS's. Services start from instrumentation.ts, so this import ran
 * during SERVER BOOT: one item whose entry guarded `!parentPort` with
 * `process.exit(0)` took the entire preview server down with a clean code-0
 * exit and no error, on every boot. Any other top-level side effect (binding
 * a port, an infinite loop) would equally have hit the server itself. The
 * child inherits process.env — NODE_PATH (set per-process by
 * tools/supervisor/lib/proc.mjs) must keep resolving bare imports exactly as
 * it does for the real Worker. A module that itself exits 0 while loading
 * still passes: the check's only job is "does it load", and the real run
 * happens in a Worker where parentPort is set. SIGKILL on timeout, because a
 * top-level busy loop can install a SIGTERM handler it never services.
 */
/**
 * `serviceDirPath` is the service's OWN directory — `dataDir()/system/<id>/services`
 * under 035, where installed state is one symlink per item. It used to be the
 * shared `system/services` root with the id joined on, which no longer exists.
 */
export async function validateManifestAtStart(manifest: ServiceManifest, serviceDirPath: string): Promise<ValidationResult> {
  const entryPath = path.resolve(serviceDirPath, manifest.entry);
  const exists = await fs.access(entryPath).then(() => true).catch(() => false);
  if (!exists) {
    return { valid: false, errors: [`entrypoint not found: ${entryPath}`] };
  }
  // No NODE_OPTIONS: a worker thread never re-applies it (it holds flags the
  // PARENT node was started with — under `npm run test:unit`, a --require of a
  // cwd-relative preload that doesn't resolve from the child's cwd at all), so
  // a faithful load check must not either. NODE_PATH stays inherited — the
  // real Worker resolves bare imports through it (tools/supervisor/lib/proc.mjs).
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return await new Promise<ValidationResult>((resolve) => {
    execFile(
      process.execPath,
      ["-e", LOAD_CHECK_SCRIPT, entryPath],
      { cwd: serviceDirPath, env, timeout: LOAD_CHECK_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ valid: true, errors: [] });
        if (err.killed) {
          return resolve({
            valid: false,
            errors: [`entrypoint did not finish loading within ${LOAD_CHECK_TIMEOUT_MS}ms: ${entryPath}`],
          });
        }
        const detail = (stderr || err.message || "unknown error").trim().split("\n").slice(0, 20).join("\n");
        resolve({ valid: false, errors: [`entrypoint failed to load: ${detail}`] });
      },
    );
  });
}
