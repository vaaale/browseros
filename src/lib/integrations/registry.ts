// Framework-free integration registry. No `server-only` (client code reads
// the manifest list) and no react imports.
//
// Manifests are compiled into BOS (not user-installable in Phase 1) — a
// manifest module's `services/<id>/index.ts` calls `registerIntegration`
// at module load. The public entry point `./index.ts` imports each service
// module so registration happens as a side-effect of importing the barrel.

import type { IntegrationManifest, ServiceDefinition } from "./types";

const registry: IntegrationManifest[] = [];

export function registerIntegration(manifest: IntegrationManifest): void {
  if (registry.some((m) => m.id === manifest.id)) {
    throw new Error(`Duplicate integration id: ${manifest.id}`);
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
