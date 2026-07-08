import "server-only";

import type { ServiceAdapter } from "../adapters/base";
import type { AdapterMethodMeta } from "./types";

// Server-side lookup: for a given (integrationId, serviceId), return a fresh
// adapter instance and the method-metadata list. Kept OUT of the framework-
// free entry point (`../index.ts`) so client bundles don't pull in adapters.
//
// Adapters register themselves at module-load time by calling
// `registerAdapter(integrationId, serviceId, entry)`. Each adapter file
// imports this module and invokes the register call at the bottom of the
// file (side-effect); the service barrel (`services/gsuite/index.ts`)
// imports every adapter file so any consumer of the barrel sees a
// fully-populated registry.
//
// NOTE: this module MUST NOT import the adapter files itself — doing so
// creates a circular dependency (adapter → registry → adapter) that ESM /
// Turbopack can't sequence, producing a `Cannot access 'u' before
// initialization` TDZ error at load time. Registration is driven by the
// service barrel instead.
//
// This mirrors the manifest registry's pattern (`registerIntegration`) — we
// avoid a central hard-coded map so adding a new adapter is one file
// touched per service.

/**
 * Optional per-adapter capability flags. Consumed by the settings UI (via
 * `/api/integrations`) to gate sub-sections like Polling / Webhooks — a
 * placeholder adapter (or a read-only one that doesn't implement `pollOnce`)
 * omits `poll: true` so the UI can render a graceful "not supported" hint
 * instead of surfacing a runtime failure from `runJobOnce`.
 */
export interface AdapterCapabilities {
  poll?: boolean;
  webhook?: boolean;
}

export interface AdapterEntry {
  createAdapter: () => ServiceAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methods: readonly AdapterMethodMeta<any>[];
  capabilities?: AdapterCapabilities;
}

const ADAPTERS: Record<string, Record<string, AdapterEntry>> = {};

/**
 * Register an adapter with the server-side registry. Duplicate registrations
 * for the same `(integrationId, serviceId)` throw — matches
 * `registerIntegration` semantics so a subtle module-graph doubling
 * surfaces as a load-time failure rather than a silent overwrite.
 */
export function registerAdapter(
  integrationId: string,
  serviceId: string,
  entry: AdapterEntry,
): void {
  const bucket = ADAPTERS[integrationId] ?? (ADAPTERS[integrationId] = {});
  if (bucket[serviceId]) {
    throw new Error(`Duplicate adapter registration: ${integrationId}/${serviceId}`);
  }
  bucket[serviceId] = entry;
}

export function getAdapterEntry(integrationId: string, serviceId: string): AdapterEntry | undefined {
  return ADAPTERS[integrationId]?.[serviceId];
}

export function getAdapterMethod(
  integrationId: string,
  serviceId: string,
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AdapterMethodMeta<any> | undefined {
  return getAdapterEntry(integrationId, serviceId)?.methods.find((m) => m.method === method);
}

export function listAdapterServices(): Array<{
  integrationId: string;
  serviceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methods: readonly AdapterMethodMeta<any>[];
  capabilities: AdapterCapabilities;
}> {
  const out: Array<{
    integrationId: string;
    serviceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    methods: readonly AdapterMethodMeta<any>[];
    capabilities: AdapterCapabilities;
  }> = [];
  for (const [integrationId, services] of Object.entries(ADAPTERS)) {
    for (const [serviceId, entry] of Object.entries(services)) {
      out.push({
        integrationId,
        serviceId,
        methods: entry.methods,
        capabilities: entry.capabilities ?? {},
      });
    }
  }
  return out;
}

/** Test-only: wipe the registry. */
export function _resetAdapterRegistry(): void {
  for (const k of Object.keys(ADAPTERS)) delete ADAPTERS[k];
}
