"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, LogOut, Plug, RefreshCw, Zap } from "lucide-react";
import type { IntegrationSummary } from "./useIntegrations";
import { ClientSecretUpload } from "./ClientSecretUpload";

// Small "auth card" showing the connection status + Connect / Reauthorize /
// Disconnect controls. When connected + Gmail scope granted, the card can
// display the user's email address (fetched via /api/integrations/gsuite/whoami
// which is a thin passthrough to getProfile()).

interface WhoAmI {
  emailAddress?: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export interface IntegrationDetailViewProps {
  item: IntegrationSummary;
  onOpenService: (serviceId: string) => void;
  onRefresh: () => Promise<void>;
  onDisconnect: (id: string) => Promise<void>;
}

export function IntegrationDetailView({ item, onOpenService, onRefresh, onDisconnect }: IntegrationDetailViewProps) {
  const [whoAmI, setWhoAmI] = useState<WhoAmI | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const loadWhoAmI = useCallback(async () => {
    if (!item.state.connected) {
      setWhoAmI(undefined);
      return;
    }
    if (item.manifest.id !== "gsuite") return; // Phase 1: gsuite-specific endpoint only.
    try {
      const res = await fetch(`/api/integrations/gsuite/whoami`);
      if (!res.ok) return;
      const body = (await res.json()) as WhoAmI;
      setWhoAmI(body);
    } catch {
      // best-effort
    }
  }, [item.manifest.id, item.state.connected]);

  useEffect(() => {
    void loadWhoAmI();
  }, [loadWhoAmI]);

  const startConnect = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(
        `/api/integrations/oauth/start?integrationId=${encodeURIComponent(item.manifest.id)}`,
      );
      const body = (await res.json()) as { authUrl?: string; error?: string };
      if (!res.ok || !body.authUrl) throw new Error(body.error ?? "Failed to start OAuth flow.");
      const popup = window.open(body.authUrl, "bos-oauth", "width=520,height=680");
      if (!popup) throw new Error("Popup was blocked. Allow popups for this site and try again.");

      const listener = (ev: MessageEvent) => {
        const data = ev.data as { type?: string; ok?: boolean; error?: string } | null;
        if (!data || data.type !== "bos-oauth") return;
        window.removeEventListener("message", listener);
        if (!data.ok) setError(data.error ?? "Connection failed.");
        void onRefresh();
        void loadWhoAmI();
      };
      window.addEventListener("message", listener);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [item.manifest.id, onRefresh, loadWhoAmI]);

  const doDisconnect = useCallback(async () => {
    if (!confirm(`Disconnect ${item.manifest.name}? Tokens will be cleared.`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDisconnect(item.manifest.id);
      setWhoAmI(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [item.manifest.id, item.manifest.name, onDisconnect]);

  const connected = item.state.connected;

  return (
    <div className="space-y-4">
      {!item.hasClientSecret && (
        <ClientSecretUpload integrationId={item.manifest.id} onUploaded={onRefresh} />
      )}

      <section className="rounded-lg border border-white/10 bg-white/[0.05] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  connected ? "bg-emerald-400" : "bg-white/25"
                }`}
              />
              <span className="text-[13px] font-medium">
                {connected ? "Connected" : "Not connected"}
              </span>
            </div>
            {connected && whoAmI?.emailAddress && (
              <div className="mt-1 text-[12px] text-white/70">
                Connected as <span className="font-medium">{whoAmI.emailAddress}</span>
              </div>
            )}
            {item.state.lastError && (
              <div className="mt-2 rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
                {item.state.lastError}
              </div>
            )}
            {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!connected && item.hasClientSecret && (
              <button
                type="button"
                onClick={startConnect}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
              >
                <Plug size={12} /> Connect
              </button>
            )}
            {connected && (
              <>
                <button
                  type="button"
                  onClick={startConnect}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1.5 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  <RefreshCw size={12} /> Reauthorize
                </button>
                <button
                  type="button"
                  onClick={doDisconnect}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded border border-red-400/40 px-2.5 py-1.5 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-50"
                >
                  <LogOut size={12} /> Disconnect
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      <section>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Services</h4>
        <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
          {item.manifest.services.map((svc) => {
            const svcState = item.state.services[svc.id];
            return (
              <button
                key={svc.id}
                type="button"
                onClick={() => onOpenService(svc.id)}
                className="flex w-full items-center justify-between border-b border-white/5 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-white/10"
              >
                <div className="flex items-center gap-3">
                  <Zap size={14} className="text-white/50" />
                  <div>
                    <div className="text-[13px] font-medium">{svc.name}</div>
                    <div className="text-[11px] text-white/50">{svc.description}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[11px] ${
                      svcState?.enabled === false ? "text-white/40" : "text-emerald-300"
                    }`}
                  >
                    {svcState?.enabled === false ? "Disabled" : "Enabled"}
                  </span>
                  <ChevronRight size={16} className="text-white/30" />
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
