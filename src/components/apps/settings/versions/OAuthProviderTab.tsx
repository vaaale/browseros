"use client";

import { useCallback, useEffect, useState } from "react";
import {
  GitBranch,
  Loader2,
  Wifi,
  WifiOff,
  AlertCircle,
  Unplug,
} from "lucide-react";
import { sessionHeader } from "@/lib/logging/client/session";

interface GitRemote {
  name: string;
  url: string;
  provider: "github" | "gitlab" | "generic";
  autoPush: boolean;
  lastFetched?: string;
  lastPushed?: string;
  inGitConfig: boolean;
  status: string;
}

interface OAuthProvider {
  id: string;
  name: string;
  icon: string;
  description: string;
}

const PROVIDER_ICONS: Record<string, React.FC<{ size?: number }>> = {
  github: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
  gitlab: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M15.545 6.423L10.374.377a.457.457 0 00-.851.178L8.258 6.423H7.742l.271-5.868a.457.457 0 00-.851-.178L.455 6.423A.55.55 0 00.5 6.9v.207a.55.55 0 00.385.524l3.717 1.177-2.046 6.14a.457.457 0 00.62.577L8 13.09l4.864 2.435a.457.457 0 00.62-.577l-2.046-6.14 3.717-1.177A.55.55 0 0015.5 7.107V.69a.55.55 0 00.045-.267z" />
    </svg>
  ),
};

function ProviderIcon({ provider, size = 14 }: { provider: string; size?: number }) {
  const Icon = PROVIDER_ICONS[provider];
  if (Icon) return <Icon size={size} />;
  return <GitBranch size={size} className="text-white/50" />;
}

function RemotesUsingProvider({ providerId, remotes }: { providerId: string; remotes: GitRemote[] }) {
  const matching = remotes.filter((r) => r.provider === providerId);
  if (matching.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {matching.map((r) => (
        <span key={r.name} className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50">
          <ProviderIcon provider={r.provider} size={10} />
          {r.name}
        </span>
      ))}
    </div>
  );
}

export function OAuthProviderTab() {
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [remotesRes, providersRes] = await Promise.all([
        fetch("/api/git-remotes"),
        fetch("/api/integrations"),
      ]);
      if (remotesRes.ok) {
        const data = await remotesRes.json();
        setRemotes(data.remotes ?? []);
      }
      if (providersRes.ok) {
        const data = await providersRes.json();
        const allProviders: OAuthProvider[] = [];
        for (const integration of data.integrations ?? []) {
          if (integration.oauthConfig) {
            allProviders.push({
              id: integration.id,
              name: integration.name,
              icon: integration.icon,
              description: integration.description,
            });
          }
        }
        setProviders(allProviders.filter((p) => p.id === "github" || p.id === "gitlab"));
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const connect = useCallback((providerId: string) => {
    setBusyAction(providerId);
    setMsg(null);

    const popup = window.open(
      `/api/git-remotes/oauth/start?remoteName=git-oauth&provider=${providerId}`,
      "git-oauth-connect",
      "width=600,height=700,popup=yes",
    );

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== "bos-git-oauth") return;
      window.removeEventListener("message", handler);

      setBusyAction(null);
      if (data.ok) {
        setMsg(`Connected ${data.providerName ?? providerId} successfully.`);
        void load();
      } else {
        setMsg(`Error: ${data.error ?? "Connection failed"}`);
      }
    };
    window.addEventListener("message", handler);

    const timer = setInterval(() => {
      if (!popup || popup.closed) {
        clearInterval(timer);
        window.removeEventListener("message", handler);
        setBusyAction(null);
      }
    }, 500);
  }, [load]);

  const disconnect = useCallback(async (providerId: string) => {
    setBusyAction(`disconnect-${providerId}`);
    setMsg(null);
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader() },
        body: JSON.stringify({ action: "disconnect", integrationId: providerId }),
      });
      if (res.ok) {
        setMsg(`Disconnected ${providerId}.`);
        void load();
      } else {
        const data = await res.json();
        setMsg(`Error: ${data.error ?? "Disconnect failed"}`);
      }
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusyAction(null);
    }
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40">
        <Loader2 size={14} className="animate-spin" />
        Loading providers…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-white/50">OAuth Providers</h4>
        <p className="mt-1 text-[11px] text-white/40">
          Connect GitHub or GitLab accounts to authenticate git remotes via OAuth.
        </p>
      </div>

      {providers.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
          <GitBranch size={24} className="mx-auto mb-2 text-white/20" />
          <p className="text-[12px] text-white/40">No OAuth providers configured.</p>
          <p className="mt-1 text-[11px] text-white/30">
            Upload client credentials in Settings → Integrations to enable OAuth.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {providers.map((provider) => {
            const isBusy = busyAction === provider.id || busyAction === `disconnect-${provider.id}`;
            return (
              <div
                key={provider.id}
                className="rounded-lg border border-white/10 bg-white/[0.03] p-3"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <ProviderIcon provider={provider.id} size={16} />
                      <span className="text-[13px] font-medium">{provider.name}</span>
                      <span className="inline-flex items-center gap-1 text-[11px] text-white/50">
                        <WifiOff size={10} />
                        OAuth
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-white/40">{provider.description}</p>
                    <RemotesUsingProvider providerId={provider.id} remotes={remotes} />
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      disabled={isBusy}
                      onClick={() => connect(provider.id)}
                      className="inline-flex items-center gap-1.5 rounded bg-emerald-500/20 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-40"
                    >
                      {busyAction === provider.id ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Wifi size={10} />
                      )}
                      Connect
                    </button>
                    <button
                      disabled={isBusy}
                      onClick={() => void disconnect(provider.id)}
                      className="inline-flex items-center gap-1.5 rounded bg-red-500/15 px-2.5 py-1 text-[11px] font-medium text-red-300/80 hover:bg-red-500/25 disabled:opacity-40"
                    >
                      {busyAction === `disconnect-${provider.id}` ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Unplug size={10} />
                      )}
                      Disconnect
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {msg && (
        <div className="flex items-start gap-2 rounded border border-white/10 bg-white/[0.03] p-2 text-[11px] text-white/60">
          {msg.startsWith("Error") && <AlertCircle size={12} className="mt-0.5 shrink-0 text-amber-400" />}
          {msg}
        </div>
      )}
    </div>
  );
}
