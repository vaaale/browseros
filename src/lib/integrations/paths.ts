import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";

// Path helpers for the integrations subsystem. All paths derive from
// `dataDir()` so BOS_DATA_DIR overrides (live-version-control) work here
// too. See specs/user-specs/integrations-framework/plan.md §4.
//
// Layout:
//   data/
//   ├── .integrations-key                 (32 random bytes, chmod 600)
//   └── integrations/
//       ├── secrets.json                  (encrypted blob)
//       └── <integrationId>/
//           └── state.json

/** Absolute path to `data/integrations/`. */
export function integrationsRoot(): string {
  return path.join(dataDir(), "integrations");
}

/** Absolute path to the encrypted secrets blob. */
export function secretsFile(): string {
  return path.join(integrationsRoot(), "secrets.json");
}

/**
 * Absolute path to the AES-256 keyfile. Lives directly under `data/` (not
 * under `data/integrations/`) so an accidental `rm -rf data/integrations`
 * doesn't strand the ciphertext without its key elsewhere.
 */
export function keyfilePath(): string {
  return path.join(dataDir(), ".integrations-key");
}

/** Absolute path to a per-integration state.json. */
export function stateFile(integrationId: string): string {
  return path.join(integrationsRoot(), integrationId, "state.json");
}

/** Ensures `data/integrations/` exists. Idempotent. */
export async function ensureIntegrationsRoot(): Promise<void> {
  await fs.mkdir(integrationsRoot(), { recursive: true });
}

/** Ensures `data/integrations/<integrationId>/` exists. Idempotent. */
export async function ensureIntegrationDir(integrationId: string): Promise<void> {
  await fs.mkdir(path.join(integrationsRoot(), integrationId), { recursive: true });
}
