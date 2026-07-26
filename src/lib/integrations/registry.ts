// Framework-free integration registry. No `server-only` (client code reads
// the manifest list) and no react imports.
//
// Manifests are compiled into BOS (not user-installable in Phase 1) — a
// manifest module's `services/<id>/index.ts` calls `registerIntegration`
// at module load. The public entry point `./index.ts` imports each service
// module so registration happens as a side-effect of importing the barrel.

import type { IntegrationManifest, ServiceDefinition } from "./types";

// Use globalThis as the backing store so the registry survives Next.js dev-mode
// HMR module re-evaluations. Without this, each hot-reload re-runs the
// registerIntegration side-effects in services/*/index.ts while the registry
// array from the previous evaluation still holds the old entries, causing a
// spurious "Duplicate integration id" throw.
const REGISTRY_KEY = "__bos_integration_registry__";
const g = globalThis as Record<string, unknown>;
if (!Array.isArray(g[REGISTRY_KEY])) g[REGISTRY_KEY] = [];
const registry = g[REGISTRY_KEY] as IntegrationManifest[];

export function registerIntegration(manifest: IntegrationManifest): void {
  const idx = registry.findIndex((m) => m.id === manifest.id);
  if (idx !== -1) {
    // Replace on re-registration (HMR re-evaluated the module). A true
    // collision between two *different* integrations is caught at build time.
    registry[idx] = manifest;
    return;
  }
  registry.push(manifest);
}

/** Return the registered manifests in insertion order. */
export function listIntegrations(): IntegrationManifest[] {
  return [...registry];
}

export function getIntegration(id: string): IntegrationManifest | undefined {
  return registry.find((m) => m.id === id);
}

export function getService(integrationId: string, serviceId: string): ServiceDefinition | undefined {
  return getIntegration(integrationId)?.services.find((s) => s.id === serviceId);
}

/** Test-only: clear the registry. */
export function _resetRegistry(): void {
  registry.length = 0;
}
