"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Bot, LogOut, Plug, RefreshCw } from "lucide-react";

// Dedicated auth card for the Telegram bot service.
//
// Telegram bots don't use OAuth — the user pastes a token from @BotFather.
// This component replaces the generic "Connect via OAuth" card that
// IntegrationDetailView renders for GSuite-style integrations.
//
// Flow:
//   1. GET /api/integrations/telegram/bot/status   — is a token stored? which bot?
//   2. If not connected: show a token input + Connect button.
//      POST /api/integrations/telegram/bot/connect { token }
//   3. If connected: show "Connected as @<username>" + Disconnect / Reconnect.
//      POST /api/integrations/telegram/bot/disconnect
//
// The token itself is written to SecretsStore server-side — this component
// never re-reads it.

interface BotInfo {
  id: number;
  first_name: string;
  username?: string;
}

interface StatusResponse {
  connected: boolean;
  botInfo?: BotInfo;
  queueDepth?: number;
  error?: string;
}

export interface TelegramBotAuthSectionProps {
  onChange?: () => void | Promise<void>;
}

export function TelegramBotAuthSection({ onChange }: TelegramBotAuthSectionProps) {
  const [status, setStatus] = useState<StatusResponse | undefined>();
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations/telegram/bot/status");
      const body = (await res.json()) as StatusResponse;
      setStatus(body);
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

  const connect = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/integrations/telegram/bot/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: { message?: string };
      };
      if (!res.ok || !body.ok) throw new Error(body.error?.message ?? "Connect failed.");
      setToken("");
      await refresh();
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [token, refresh, onChange]);

  const disconnect = useCallback(async () => {
    if (!confirm("Disconnect the Telegram bot? The token will be cleared. User settings (poll interval, webhook config) are preserved.")) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/integrations/telegram/bot/disconnect", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? "Disconnect failed.");
      }
      await refresh();
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [refresh, onChange]);

  const connected = status?.connected === true;
  const bot = status?.botInfo;

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.05] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? "bg-emerald-400" : "bg-white/25"
              }`}
            />
            <span className="text-[13px] font-medium">
              {loading ? "Checking…" : connected ? "Connected" : "Not connected"}
            </span>
          </div>
          {connected && bot && (
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-white/70">
              <Bot size={12} />
              <span>
                Connected as{" "}
                <span className="font-medium">
                  {bot.username ? `@${bot.username}` : bot.first_name}
                </span>
              </span>
            </div>
          )}
          {status?.error && (
            <div className="mt-2 rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
              {status.error}
            </div>
          )}
          {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {connected && (
            <>
              <button
                type="button"
                onClick={refresh}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1.5 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                <RefreshCw size={12} /> Refresh
              </button>
              <button
                type="button"
                onClick={disconnect}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded border border-red-400/40 px-2.5 py-1.5 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-50"
              >
                <LogOut size={12} /> Disconnect
              </button>
            </>
          )}
        </div>
      </div>

      {!connected && !loading && (
        <div className="mt-4 space-y-2">
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Bot token
          </label>
          <p className="text-[11px] text-white/60">
            Paste the token from{" "}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="text-violet-300 underline"
            >
              @BotFather
            </a>{" "}
            — it looks like <code className="rounded bg-black/30 px-1">123456789:AAExxxxxxx…</code>.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456789:AA…"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 rounded border border-white/15 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-white placeholder-white/25 focus:border-violet-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={connect}
              disabled={busy || token.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
            >
              <Plug size={12} /> {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
          <p className="flex items-start gap-1.5 text-[11px] text-white/40">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            Stored encrypted at rest via BOS SecretsStore. Never leaves your BrowserOS install.
          </p>
        </div>
      )}
    </section>
  );
}
