"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plug, Unplug } from "lucide-react";
import { OAuthCredentialsPanel } from "./OAuthCredentialsPanel";
import { GIT_REMOTE_OAUTH_CALLBACK_PATH, getBrowserOrigin } from "@/lib/integrations/oauth/origin";

interface ProviderStatus {
  id: string;
  name: string;
  connected: boolean;
  connectedAs?: string;
  hasClientCredentials: boolean;
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
  return null;
}

export function GitProvidersTab({ onRefresh: _onRefresh }: { onRefresh?: () => Promise<void> }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/integrations/git-providers");
      if (!res.ok) throw new Error("Failed to load git providers");
      const data = await res.json();
      setProviders(data.providers ?? []);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const connect = useCallback(
    (providerId: string) => {
      setBusyProvider(providerId);
      setError(undefined);

      // Forward the browser's known public URL (the address bar). Behind a
      // reverse proxy that rewrites Host, the server can't infer it — but the
      // browser can, and it's the origin the redirect URI must be built from.
      const browserOrigin = getBrowserOrigin();
      const popup = window.open(
        `/api/git-remotes/oauth/start?remoteName=git-oauth&provider=${encodeURIComponent(providerId)}` +
          `&browserOrigin=${encodeURIComponent(browserOrigin)}`,
        "git-oauth-connect",
        "width=600,height=700,popup=yes",
      );

      const handler = (event: MessageEvent) => {
        const data = event.data;
        if (!data || typeof data !== "object" || data.type !== "bos-git-oauth") return;
        window.removeEventListener("message", handler);

        setBusyProvider(null);
        if (data.ok) {
          void load();
          void _onRefresh?.();
        } else {
          setError(data.error ?? "Connection failed");
        }
      };
      window.addEventListener("message", handler);

      const timer = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(timer);
          window.removeEventListener("message", handler);
          setBusyProvider(null);
        }
      }, 500);
    },
    [load, _onRefresh],
  );

  const disconnect = useCallback(
    async (providerId: string) => {
      setBusyProvider(providerId);
      setError(undefined);
      try {
        const res = await fetch("/api/integrations/git-providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "disconnect", providerId }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? "Disconnect failed");
        }
        await load();
        void _onRefresh?.();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusyProvider(null);
      }
    },
    [load, _onRefresh],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40">
        <Loader2 size={14} className="animate-spin" />
        Loading git providers…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-white/50">Git Providers</h4>
        <p className="mt-1 text-[11px] text-white/40">
          Connect GitHub or GitLab accounts to authenticate git remotes via OAuth.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-400/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
          {error}
        </div>
      )}

      {providers.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center">
          <p className="text-[12px] text-white/40">No git providers available.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.05]">
          {providers.map((provider) => {
            const isBusy = busyProvider === provider.id;
            const isConfiguring = configuring === provider.id;
            return (
              <div key={provider.id} className="border-b border-white/5 last:border-b-0">
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        provider.connected ? "bg-emerald-400" : "bg-white/25"
                      }`}
                    />
                    <ProviderIcon provider={provider.id} size={16} />
                    <div>
                      <div className="text-[13px] font-medium">{provider.name}</div>
                      <div className="text-[11px] text-white/50">
                        {provider.connected
                          ? `● Connected${provider.connectedAs ? ` as ${provider.connectedAs}` : ""}`
                          : provider.hasClientCredentials
                            ? "○ Not connected"
                            : "○ Credentials required"}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfiguring(isConfiguring ? null : provider.id)}
                      disabled={isBusy}
                      className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                        isConfiguring
                          ? "border-violet-400/60 text-violet-200"
                          : "border-white/15 text-white/80 hover:bg-white/10"
                      }`}
                    >
                      <KeyRound size={10} />
                      {provider.hasClientCredentials ? "Credentials" : "Add credentials"}
                    </button>
                    {!provider.connected && (
                      <button
                        type="button"
                        onClick={() => connect(provider.id)}
                        disabled={isBusy || !provider.hasClientCredentials}
                        title={provider.hasClientCredentials ? undefined : "Configure credentials first"}
                        className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Plug size={10} />
                        )}
                        Connect
                      </button>
                    )}
                    {provider.connected && (
                      <button
                        type="button"
                        onClick={() => void disconnect(provider.id)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1.5 rounded border border-red-400/40 px-2.5 py-1.5 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Unplug size={10} />
                        )}
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
                {isConfiguring && (
                  <div className="px-4 pb-4">
                    <OAuthCredentialsPanel
                      integrationId={provider.id}
                      providerName={provider.name}
                      hasCredentials={provider.hasClientCredentials}
                      redirectUriPath={GIT_REMOTE_OAUTH_CALLBACK_PATH}
                      onSaved={async () => {
                        await load();
                        setConfiguring(null);
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
