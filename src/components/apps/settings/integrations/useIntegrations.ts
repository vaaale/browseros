"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IntegrationManifest, IntegrationState } from "@/lib/integrations/types";

// Shape mirrors the API response in src/app/api/integrations/route.ts.
export interface IntegrationSummary {
  manifest: IntegrationManifest;
  state: IntegrationState;
  hasClientSecret: boolean;
}

interface UseIntegrationsResult {
  loading: boolean;
  items: IntegrationSummary[];
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/integrations").then((r) => r.json());
      setItems((res.integrations as IntegrationSummary[]) ?? []);
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

  return { loading, items, error, refresh, patch, disconnect };
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
  };
  if (map[scope]) return map[scope];
  // Fallback: trim to the trailing path segment.
  const idx = scope.lastIndexOf("/");
  return idx >= 0 ? scope.slice(idx + 1) : scope;
}
