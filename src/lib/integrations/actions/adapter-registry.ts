import "server-only";

import type { ServiceAdapter } from "../adapters/base";
import type { AdapterMethodMeta } from "./types";
import { GmailAdapter, GMAIL_METHODS } from "../services/gsuite/adapters/gmail";

// Server-side lookup: for a given (integrationId, serviceId), return a fresh
// adapter instance and the method-metadata list. Kept OUT of the framework-
// free entry point (`../index.ts`) so client bundles don't pull in adapters.
//
// Adding a service here is the ONLY registration a new adapter needs — the
// invoke route, the dispatcher, and the assistant tool wiring all discover it
// through this map.

interface AdapterEntry {
  createAdapter: () => ServiceAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methods: readonly AdapterMethodMeta<any>[];
}

const ADAPTERS: Record<string, Record<string, AdapterEntry>> = {
  gsuite: {
    gmail: {
      createAdapter: () => new GmailAdapter(),
      methods: GMAIL_METHODS,
    },
  },
};

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
}> {
  const out: Array<{
    integrationId: string;
    serviceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    methods: readonly AdapterMethodMeta<any>[];
  }> = [];
  for (const [integrationId, services] of Object.entries(ADAPTERS)) {
    for (const [serviceId, entry] of Object.entries(services)) {
      out.push({ integrationId, serviceId, methods: entry.methods });
    }
  }
  return out;
}
