import type { PluginHookType } from "./types";

// Plugin manifest validation — ensures manifests are well-formed before loading.

const VALID_HOOK_TYPES: PluginHookType[] = [
  "beforeRun",
  "extendSystemPrompt",
  "beforeToolCall",
  "afterToolCall",
  "afterRun",
  "onRunFinished",
  "onError",
];

const VALID_TYPES = new Set(["server-plugin"]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a plugin manifest. Returns { valid: true } or { valid: false, errors: [...] }. */
export function validateManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["manifest is not an object"] };
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.id !== "string" || !m.id.trim()) {
    errors.push("manifest.id is required and must be a non-empty string");
  } else if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(m.id)) {
    errors.push("manifest.id must be lowercase alphanumeric with optional dots, hyphens, or underscores");
  }

  if (typeof m.name !== "string" || !m.name.trim()) {
    errors.push("manifest.name is required and must be a non-empty string");
  }

  if (typeof m.version !== "string" || !m.version.trim()) {
    errors.push("manifest.version is required and must be a semver string");
  }

  if (!VALID_TYPES.has(m.type as string)) {
    errors.push(`manifest.type must be one of: ${[...VALID_TYPES].join(", ")}`);
  }

  if (!Array.isArray(m.provides)) {
    errors.push("manifest.provides must be an array of hook types");
  } else {
    for (const hook of m.provides) {
      if (!VALID_HOOK_TYPES.includes(hook as PluginHookType)) {
        errors.push(`unknown hook type "${hook}" in provides; valid: ${VALID_HOOK_TYPES.join(", ")}`);
      }
    }
  }

  if (m.entry !== undefined && typeof m.entry !== "string") {
    errors.push("manifest.entry must be a string if provided");
  }

  if (m.configApp !== undefined && typeof m.configApp !== "string") {
    errors.push("manifest.configApp must be a string if provided");
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

  return { valid: errors.length === 0, errors };
}

/** Validate a plugin.json file content. Convenience wrapper. */
export function validatePluginJson(content: string): ValidationResult {
  try {
    const parsed = JSON.parse(content);
    return validateManifest(parsed);
  } catch {
    return { valid: false, errors: ["invalid JSON"] };
  }
}
