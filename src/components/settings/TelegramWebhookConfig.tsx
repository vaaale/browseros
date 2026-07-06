"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Globe,
  KeyRound,
  Play,
  ShieldCheck,
  Zap,
} from "lucide-react";
import type { WebhookConfig } from "@/lib/integrations/webhooks/types";

// Telegram-specific webhook configuration panel.
//
// Renders the Telegram-flavoured version of the generic WebhookSection: the
// controls the user cares about are the receiver URL (which they paste into
// their Bot API `setWebhook` call), the optional secret token that Telegram
// echoes in the `X-Telegram-Bot-Api-Secret-Token` header, and the
// `allowed_updates` array which filters which update types Telegram pushes.
//
// The heavy lifting (setWebhook / deleteWebhook to Telegram) is done server-
// side by TelegramBotWebhookHandler.onEnable / .onDisable — this component
// only edits the shared WebhookConfig via the standard framework routes and
// then flips enabled to trigger the handler.
//
// Wire endpoints (identical to the generic WebhookSection):
//   GET   /api/integrations/telegram/services/bot/webhook
//   POST  .../webhook             action: enable | disable | delete
//   PATCH .../webhook             partial config update (extras)
//   POST  .../webhook/test        drop a synthetic event

type AllowedUpdate =
  | "message"
  | "edited_message"
  | "channel_post"
  | "edited_channel_post"
  | "callback_query"
  | "inline_query"
  | "chosen_inline_result"
  | "shipping_query"
  | "pre_checkout_query"
  | "poll"
  | "poll_answer"
  | "my_chat_member"
  | "chat_member"
  | "chat_join_request";

const AVAILABLE_UPDATES: AllowedUpdate[] = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "inline_query",
  "chosen_inline_result",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
];

interface TelegramWebhookExtras {
  secretToken?: string;
  allowedUpdates?: string[];
  registeredUrl?: string;
}

interface WebhookSnapshot {
  config: WebhookConfig | undefined;
  hasSecret: boolean;
  url: string;
  origin: string;
}

export interface TelegramWebhookConfigProps {
  /** Optional parent callback fired after enable/disable/save so the outer
   *  settings screen can refresh its own state.*/
  onChange?: () => void | Promise<void>;
}

export function TelegramWebhookConfig({ onChange }: TelegramWebhookConfigProps) {
  const [snapshot, setSnapshot] = useState<WebhookSnapshot | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [testResult, setTestResult] = useState<string | undefined>();
  const [secretToken, setSecretToken] = useState("");
  const [allowedUpdates, setAllowedUpdates] = useState<Set<AllowedUpdate>>(
    () => new Set<AllowedUpdate>(["message", "edited_message", "callback_query"]),
  );

  const base = "/api/integrations/telegram/services/bot/webhook";

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(base);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load webhook (${res.status})`);
      }
      const body = (await res.json()) as WebhookSnapshot;
      setSnapshot(body);
      const extras = (body.config?.extras as TelegramWebhookExtras | undefined) ?? {};
      setSecretToken(extras.secretToken ?? "");
      if (Array.isArray(extras.allowedUpdates) && extras.allowedUpdates.length > 0) {
        setAllowedUpdates(new Set<AllowedUpdate>(extras.allowedUpdates as AllowedUpdate[]));
      }
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const buildExtras = useCallback((): TelegramWebhookExtras => {
    return {
      secretToken: secretToken.trim() || undefined,
      allowedUpdates: [...allowedUpdates],
    };
  }, [secretToken, allowedUpdates]);

  const doAction = useCallback(
    async (action: "enable" | "disable" | "delete") => {
      setBusy(true);
      setError(undefined);
      setTestResult(undefined);
      try {
        const patch: Partial<WebhookConfig> | undefined =
          action === "enable" ? { extras: buildExtras() } : undefined;
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, patch }),
        });
        const body = (await res.json()) as WebhookSnapshot | { error?: string };
        if (!res.ok) throw new Error((body as { error?: string }).error ?? `Action failed: ${res.status}`);
        setSnapshot(body as WebhookSnapshot);
        await onChange?.();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [base, buildExtras, onChange],
  );

  const saveExtras = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extras: buildExtras() }),
      });
      const body = (await res.json()) as WebhookSnapshot | { error?: string };
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Save failed: ${res.status}`);
      setSnapshot(body as WebhookSnapshot);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [base, buildExtras]);

  const test = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setTestResult(undefined);
    try {
      const res = await fetch(`${base}/test`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Test failed: ${res.status}`);
      setTestResult("Test event dispatched to the notifications inbox.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [base]);

  const copyUrl = useCallback(async () => {
    if (!snapshot?.url) return;
    try {
      await navigator.clipboard.writeText(snapshot.url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1500);
    } catch {
      /* clipboard may be blocked — ignore */
    }
  }, [snapshot?.url]);

  const toggleUpdate = useCallback((kind: AllowedUpdate) => {
    setAllowedUpdates((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const enabled = snapshot?.config?.enabled === true;
  const extras = (snapshot?.config?.extras as TelegramWebhookExtras | undefined) ?? {};
  const registered = extras.registeredUrl;

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.05] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          <Globe size={12} /> Telegram webhook
          {enabled ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-normal normal-case text-emerald-300">
              Enabled
            </span>
          ) : (
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-normal normal-case text-white/60">
              Disabled
            </span>
          )}
          {extras.secretToken && (
            <span className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-normal normal-case text-violet-300">
              <ShieldCheck size={10} /> Secret set
            </span>
          )}
        </h4>
        <div className="flex items-center gap-2">
          {enabled && (
            <button
              type="button"
              onClick={test}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              <Play size={12} /> Test
            </button>
          )}
          {enabled ? (
            <button
              type="button"
              onClick={() => doAction("disable")}
              disabled={busy}
              className="rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              Disable
            </button>
          ) : (
            <button
              type="button"
              onClick={() => doAction("enable")}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
            >
              <Zap size={12} /> Enable
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-[11px] text-white/40">Loading webhook status…</p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="block text-[11px] text-white/60">Receiver URL</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-white/70">
                {snapshot?.url ?? "—"}
              </code>
              <button
                type="button"
                onClick={copyUrl}
                disabled={!snapshot?.url}
                className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/10 disabled:opacity-40"
              >
                {copiedUrl ? <Check size={12} /> : <Copy size={12} />}
                {copiedUrl ? "Copied" : "Copy"}
              </button>
            </div>
            {registered && (
              <span className="block text-[10px] text-emerald-300/80">
                Registered with Telegram: {registered}
              </span>
            )}
            <p className="text-[10px] text-white/40">
              BOS calls Telegram&apos;s <code>setWebhook</code> automatically when you click
              Enable. Telegram POSTs updates here.
            </p>
          </div>

          <div className="space-y-1">
            <label className="block text-[11px] text-white/60">
              <KeyRound size={10} className="inline align-middle" /> Secret token (optional)
            </label>
            <input
              type="password"
              value={secretToken}
              onChange={(e) => setSecretToken(e.target.value)}
              placeholder="1–256 random chars — echoed by Telegram to prove authenticity"
              className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 font-mono text-[11px] text-white/80 placeholder:text-white/25"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[10px] text-white/40">
              When set, BOS requires every incoming request to carry a matching
              <code className="mx-1 rounded bg-black/30 px-1">X-Telegram-Bot-Api-Secret-Token</code>
              header.
            </p>
          </div>

          <div className="space-y-1">
            <span className="block text-[11px] text-white/60">Update types to receive</span>
            <div className="flex flex-wrap gap-1.5">
              {AVAILABLE_UPDATES.map((kind) => {
                const on = allowedUpdates.has(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => toggleUpdate(kind)}
                    className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                      on
                        ? "border-violet-400/40 bg-violet-500/20 text-violet-200"
                        : "border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/10"
                    }`}
                  >
                    {kind}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-white/40">
              Only the ticked update types will be pushed. Leaving all off falls back to
              Telegram&apos;s default set (message, edited_message, channel_post, edited_channel_post,
              my_chat_member).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={saveExtras}
              disabled={busy}
              className="rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                if (!confirm("Delete webhook config and secret? Telegram will stop pushing updates.")) return;
                void doAction("delete");
              }}
              disabled={busy}
              className="rounded border border-red-400/40 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-40"
            >
              Delete
            </button>
          </div>

          {testResult && <p className="text-[11px] text-white/70">{testResult}</p>}

          {error && (
            <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2 text-[11px] text-red-200">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default TelegramWebhookConfig;
