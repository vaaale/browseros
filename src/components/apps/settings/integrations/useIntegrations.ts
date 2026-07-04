"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IntegrationManifest, IntegrationState } from "@/lib/integrations/types";

// Shape mirrors the API response in src/app/api/integrations/route.ts.
export interface IntegrationSummary {
  manifest: IntegrationManifest;
  state: IntegrationState;
  hasClientSecret: boolean;
}

/** Client-side capability mirror of the server AdapterCapabilities. */
export interface AdapterCapabilitySummary {
  poll?: boolean;
  webhook?: boolean;
}

/** One entry per (integrationId, serviceId) that has a registered adapter. */
export interface AdapterSummary {
  integrationId: string;
  serviceId: string;
  capabilities: AdapterCapabilitySummary;
}

interface UseIntegrationsResult {
  loading: boolean;
  items: IntegrationSummary[];
  adapters: AdapterSummary[];
  error?: string;
  refresh: () => Promise<void>;
  patch: (id: string, body: unknown) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
}

/**
 * Fetch + mutate the /api/integrations state. One hook shared across the
 * list, detail, and config views so a mutation from any depth refreshes the
 * whole tree.
 */
export function useIntegrations(): UseIntegrationsResult {
  const [items, setItems] = useState<IntegrationSummary[]>([]);
  const [adapters, setAdapters] = useState<AdapterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/integrations").then((r) => r.json());
      setItems((res.integrations as IntegrationSummary[]) ?? []);
      setAdapters((res.adapters as AdapterSummary[]) ?? []);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const patch = useCallback(
    async (id: string, body: unknown) => {
      const res = await fetch(`/api/integrations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `PATCH failed: ${res.status}`);
      }
      await refresh();
    },
    [refresh],
  );

  const disconnect = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/integrations/${encodeURIComponent(id)}/disconnect`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Disconnect failed: ${res.status}`);
      }
      await refresh();
    },
    [refresh],
  );

  return { loading, items, adapters, error, refresh, patch, disconnect };
}

/**
 * Lookup helper: does a registered adapter exist for the given
 * (integrationId, serviceId) pair? Placeholder services (calendar, contacts)
 * intentionally omit registration, so this returns `false` and the settings
 * UI can gate polling / webhook sub-sections accordingly.
 */
export function hasAdapter(
  adapters: AdapterSummary[],
  integrationId: string,
  serviceId: string,
): boolean {
  return adapters.some((a) => a.integrationId === integrationId && a.serviceId === serviceId);
}

/**
 * Lookup helper: does the adapter for (integrationId, serviceId) declare the
 * given capability? Returns `false` for missing adapters, missing entries, or
 * adapters that simply don't set the flag (e.g. Drive, which has an adapter
 * but no `pollOnce`).
 */
export function adapterSupports(
  adapters: AdapterSummary[],
  integrationId: string,
  serviceId: string,
  capability: keyof AdapterCapabilitySummary,
): boolean {
  const entry = adapters.find(
    (a) => a.integrationId === integrationId && a.serviceId === serviceId,
  );
  return entry?.capabilities?.[capability] === true;
}

/**
 * Compute the effective scope set (granted ∩ enabled) for a given integration
 * summary. Mirrors ServiceAdapter.getEffectiveScopes on the server.
 */
export function getEffectiveScopes(state: IntegrationState): Set<string> {
  const granted = state.oauthMeta?.granted_scopes ?? [];
  return new Set(granted.filter((s) => state.scopeOverrides[s] !== false));
}

/**
 * A per-integration hook variant that also exposes the effective scope set.
 * Consumers (IntegrationActions.tsx) subscribe here to drive `available`
 * on adapter-derived CopilotKit actions.
 */
export function useIntegrationEffectiveScopes(integrationId: string): {
  loading: boolean;
  scopes: Set<string>;
  connected: boolean;
} {
  const { items, loading } = useIntegrations();
  const match = items.find((i) => i.manifest.id === integrationId);
  const scopes = useMemo(() => (match ? getEffectiveScopes(match.state) : new Set<string>()), [match]);
  return { loading, scopes, connected: match?.state.connected ?? false };
}

/**
 * Plural variant: effective-scope sets keyed by integration id, for callers
 * (e.g. IntegrationActions.tsx) that need to drive CopilotKit `available`
 * flags across many integrations at once.
 */
export function useIntegrationsEffectiveScopes(): {
  loading: boolean;
  /** integrationId → Set of effective full-URL scope ids. */
  byIntegration: Record<string, Set<string>>;
  connected: Record<string, boolean>;
} {
  const { items, loading } = useIntegrations();
  const byIntegration = useMemo(() => {
    const out: Record<string, Set<string>> = {};
    for (const item of items) out[item.manifest.id] = getEffectiveScopes(item.state);
    return out;
  }, [items]);
  const connected = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const item of items) out[item.manifest.id] = item.state.connected;
    return out;
  }, [items]);
  return { loading, byIntegration, connected };
}

/** UI-only mapping from full-URL scopes → friendly labels. */
export function scopeLabel(scope: string): string {
  const map: Record<string, string> = {
    "https://www.googleapis.com/auth/gmail.readonly": "Read Gmail messages",
    "https://www.googleapis.com/auth/gmail.modify": "Modify Gmail labels & trash",
    "https://www.googleapis.com/auth/gmail.send": "Send email as you",
    "https://www.googleapis.com/auth/drive.readonly": "See all your Drive files (read-only)",
    "https://www.googleapis.com/auth/drive.file": "Access only files this app opens or creates",
    "https://www.googleapis.com/auth/calendar.readonly": "Read your calendars & events",
    "https://www.googleapis.com/auth/calendar.events": "Create, edit & delete calendar events",
    "https://www.googleapis.com/auth/contacts.readonly": "Read your contacts",
  };
  if (map[scope]) return map[scope];
  // Fallback: trim to the trailing path segment.
  const idx = scope.lastIndexOf("/");
  return idx >= 0 ? scope.slice(idx + 1) : scope;
}

/**
 * Open the OAuth popup with a specific scope subset — used when a user wants
 * to grant a new service (e.g. Drive) without re-consenting to already-
 * granted scopes. Google's `include_granted_scopes=true` (set in the start
 * flow) merges the delta with the existing grant.
 *
 * Returns a promise that resolves when the callback posts `bos-oauth` and
 * `refresh()` has been called. Rejects on error.
 */
export function useReconnectWithScopes(): {
  reconnect: (integrationId: string, scopes: string[]) => Promise<void>;
} {
  const { refresh } = useIntegrations();
  const reconnect = useCallback(
    async (integrationId: string, scopes: string[]) => {
      if (scopes.length === 0) throw new Error("scopes list must be non-empty");
      const qs = new URLSearchParams({
        integrationId,
        scopes: scopes.join(","),
      });
      const res = await fetch(`/api/integrations/oauth/start?${qs.toString()}`);
      const body = (await res.json()) as { authUrl?: string; error?: string };
      if (!res.ok || !body.authUrl) {
        throw new Error(body.error ?? "Failed to start OAuth flow.");
      }
      const popup = window.open(body.authUrl, `bos-oauth-${integrationId}`, "width=520,height=680");
      if (!popup) {
        throw new Error("Popup was blocked. Allow popups for this site and try again.");
      }
      await new Promise<void>((resolve, reject) => {
        const listener = (ev: MessageEvent) => {
          const data = ev.data as { type?: string; ok?: boolean; error?: string } | null;
          if (!data || data.type !== "bos-oauth") return;
          window.removeEventListener("message", listener);
          void refresh();
          if (data.ok) resolve();
          else reject(new Error(data.error ?? "Reconnect failed."));
        };
        window.addEventListener("message", listener);
      });
    },
    [refresh],
  );
  return { reconnect };
}
