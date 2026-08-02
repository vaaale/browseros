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

export interface AdapterMethodDescriptor {
  method: string;
  scope: string;
  description: string;
  parameters: import("./types").AdapterMethodParameter[];
}

export interface AdapterEntry {
  createAdapter: () => ServiceAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methods: readonly AdapterMethodMeta<any>[];
  capabilities?: AdapterCapabilities;
  /** Framework-free descriptors for the capabilities registry. */
  methodDescriptors?: readonly AdapterMethodDescriptor[];
}

const ADAPTERS_KEY = "__bos_adapter_registry__" as const;

function getAdapters(): Record<string, Record<string, AdapterEntry>> {
  const g = globalThis as Record<string, unknown>;
  if (!g[ADAPTERS_KEY]) g[ADAPTERS_KEY] = {};
  return g[ADAPTERS_KEY] as Record<string, Record<string, AdapterEntry>>;
}

/**
 * Register an adapter with the server-side registry. Duplicate registrations
 * replace the existing entry (supports HMR re-evaluation in dev and plugin
 * reload without a server restart).
 */
export function registerAdapter(
  integrationId: string,
  serviceId: string,
  entry: AdapterEntry,
): void {
  const adapters = getAdapters();
  if (!adapters[integrationId]) adapters[integrationId] = {};
  adapters[integrationId][serviceId] = entry;
}

export function unregisterAdapter(integrationId: string, serviceId: string): void {
  const adapters = getAdapters();
  if (adapters[integrationId]) {
    delete adapters[integrationId][serviceId];
    if (Object.keys(adapters[integrationId]).length === 0) delete adapters[integrationId];
  }
}

export function getAdapterEntry(integrationId: string, serviceId: string): AdapterEntry | undefined {
  return getAdapters()[integrationId]?.[serviceId];
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
  for (const [integrationId, services] of Object.entries(getAdapters())) {
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
  const adapters = getAdapters();
  for (const k of Object.keys(adapters)) delete adapters[k];
}
