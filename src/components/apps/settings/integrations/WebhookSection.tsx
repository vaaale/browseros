"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Globe,
  KeyRound,
  Play,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { IntegrationSummary } from "./useIntegrations";
import type { WebhookConfig } from "@/lib/integrations/webhooks/types";

// Webhook management UI.
//
// Wires against:
//   GET  /api/integrations/[id]/services/[serviceId]/webhook   (snapshot)
//   POST /api/integrations/[id]/services/[serviceId]/webhook   (enable/disable/rotate/delete)
//   PATCH ...                                                   (partial config: extras + eventTypes)
//   POST .../webhook/test                                       (drop a synthetic event in the inbox)

interface WebhookSnapshot {
  config: WebhookConfig | undefined;
  hasSecret: boolean;
  url: string;
  origin: string;
}

interface WebhookSectionProps {
  item: IntegrationSummary;
  serviceId: string;
  /**
   * Whether the (integrationId, serviceId) pair has a registered adapter that
   * declares `capabilities.webhook`. When false, render a "not supported"
   * placeholder and skip the initial `GET /webhook` load — the endpoint
   * relies on a registered handler that placeholder services don't have.
   */
  supported: boolean;
}

type GmailExtras = {
  topicName?: string;
  subscriptionId?: string;
  audience?: string;
  pushServiceAccount?: string;
  labelIds?: string[];
};

function isGmail(integrationId: string, serviceId: string): boolean {
  return integrationId === "gsuite" && serviceId === "gmail";
}

export function WebhookSection({ item, serviceId, supported }: WebhookSectionProps) {
  const [snapshot, setSnapshot] = useState<WebhookSnapshot | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [testResult, setTestResult] = useState<string | undefined>();
  const [revealedSecret, setRevealedSecret] = useState<string | undefined>();
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Draft state for the editable fields (extras + eventTypes)
  const [topicName, setTopicName] = useState("");
  const [audience, setAudience] = useState("");
  const [pushServiceAccount, setPushServiceAccount] = useState("");
  const [labelIds, setLabelIds] = useState("INBOX");
  const [eventTypesRaw, setEventTypesRaw] = useState("");
  const seeded = useRef(false);

  const gmail = isGmail(item.manifest.id, serviceId);
  const base = `/api/integrations/${encodeURIComponent(item.manifest.id)}/services/${encodeURIComponent(serviceId)}/webhook`;

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
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    if (!supported) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    void load();
  }, [load, supported]);

  // Seed drafts from snapshot exactly once (avoid stomping in-progress edits
  // when we poll for status updates).
  useEffect(() => {
    if (!snapshot || seeded.current) return;
    const extras = (snapshot.config?.extras as GmailExtras | undefined) ?? {};
    setTopicName(extras.topicName ?? "");
    setAudience(extras.audience ?? "");
    setPushServiceAccount(extras.pushServiceAccount ?? "");
    setLabelIds((extras.labelIds ?? ["INBOX"]).join(", "));
    setEventTypesRaw((snapshot.config?.eventTypes ?? []).join(", "));
    seeded.current = true;
  }, [snapshot]);

  const parsedExtras: GmailExtras = useMemo(() => {
    if (!gmail) return {};
    return {
      topicName: topicName.trim() || undefined,
      audience: audience.trim() || undefined,
      pushServiceAccount: pushServiceAccount.trim() || undefined,
      labelIds: labelIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }, [gmail, topicName, audience, pushServiceAccount, labelIds]);

  const parsedEventTypes: string[] = useMemo(() => {
    return eventTypesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }, [eventTypesRaw]);

  const doAction = useCallback(
    async (action: "enable" | "disable" | "rotate" | "delete") => {
      setBusy(true);
      setError(undefined);
      setTestResult(undefined);
      try {
        const patch: Partial<WebhookConfig> | undefined =
          action === "enable"
            ? {
                extras: parsedExtras,
                eventTypes: parsedEventTypes.length ? parsedEventTypes : undefined,
              }
            : undefined;
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, patch }),
        });
        const body = (await res.json()) as (WebhookSnapshot & { primary?: string }) | { error?: string };
        if (!res.ok) throw new Error((body as { error?: string }).error ?? `Action failed: ${res.status}`);
        if (action === "rotate" && (body as { primary?: string }).primary) {
          setRevealedSecret((body as { primary?: string }).primary);
        }
        if (action === "delete") {
          setRevealedSecret(undefined);
          seeded.current = false; // Re-seed on next load.
        }
        setSnapshot(body as WebhookSnapshot);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [base, parsedExtras, parsedEventTypes],
  );

  const saveConfig = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extras: parsedExtras,
          eventTypes: parsedEventTypes.length ? parsedEventTypes : undefined,
        }),
      });
      const body = (await res.json()) as WebhookSnapshot | { error?: string };
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Save failed: ${res.status}`);
      setSnapshot(body as WebhookSnapshot);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [base, parsedExtras, parsedEventTypes]);

  const testWebhook = useCallback(async () => {
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

  const copyText = useCallback(async (text: string, target: "url" | "secret") => {
    try {
      await navigator.clipboard.writeText(text);
      if (target === "url") {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 1500);
      } else {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 1500);
      }
    } catch {
      // best-effort — some sandboxed contexts block clipboard
    }
  }, []);

  const enabled = snapshot?.config?.enabled === true;
  const connected = item.state.connected;

  if (!supported) {
    return (
      <section className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
            <Globe size={12} /> Webhooks
          </h4>
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-normal normal-case text-white/60">
            Not available
          </span>
        </div>
        <p className="text-[11px] text-white/50">
          Webhooks aren&apos;t available for this service yet. They&apos;ll light up once an adapter
          with webhook support is registered.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          <Globe size={12} /> Webhooks
          {enabled ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-normal normal-case text-emerald-300">
              Enabled
            </span>
          ) : (
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-normal normal-case text-white/60">
              Disabled
            </span>
          )}
          {snapshot?.hasSecret && (
            <span className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-normal normal-case text-violet-300">
              <ShieldCheck size={10} /> Secret set
            </span>
          )}
        </h4>
        <div className="flex items-center gap-2">
          {enabled && (
            <button
              type="button"
              onClick={testWebhook}
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
              disabled={busy || !connected}
              className="rounded bg-violet-500/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
            >
              Enable
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-[11px] text-white/40">Loading webhook status…</p>
      ) : (
        <div className="space-y-3">
          {/* Receiver URL */}
          <div className="space-y-1">
            <span className="block text-[11px] text-white/60">Receiver URL</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-white/70">
                {snapshot?.url ?? "—"}
              </code>
              <button
                type="button"
                onClick={() => snapshot?.url && void copyText(snapshot.url, "url")}
                disabled={!snapshot?.url}
                className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/10 disabled:opacity-40"
              >
                {copiedUrl ? <Check size={12} /> : <Copy size={12} />}
                {copiedUrl ? "Copied" : "Copy"}
              </button>
            </div>
            <span className="block text-[10px] text-white/40">
              Paste this into your provider&apos;s push subscription config.
            </span>
          </div>

          {/* Freshly rotated secret — shown ONCE */}
          {revealedSecret && (
            <div className="rounded border border-amber-400/30 bg-amber-500/10 p-2 text-[11px]">
              <div className="mb-1 flex items-center gap-2 font-medium text-amber-200">
                <KeyRound size={12} /> Rotated secret (visible once)
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded border border-amber-400/20 bg-black/30 px-2 py-1 text-amber-100">
                  {revealedSecret}
                </code>
                <button
                  type="button"
                  onClick={() => void copyText(revealedSecret, "secret")}
                  className="inline-flex items-center gap-1 rounded border border-amber-400/30 px-2 py-1 text-amber-200 transition-colors hover:bg-amber-500/10"
                >
                  {copiedSecret ? <Check size={12} /> : <Copy size={12} />}
                  {copiedSecret ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-1 text-[10px] text-amber-200/70">
                Copy this now — it will not be shown again. The previous secret still verifies during the rotation window.
              </p>
            </div>
          )}

          {/* Gmail-specific extras */}
          {gmail && (
            <div className="space-y-2 rounded border border-white/5 bg-black/10 p-2">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-white/40">
                Gmail push (Pub/Sub)
              </span>
              <label className="block space-y-0.5 text-[11px]">
                <span className="text-white/60">Topic name</span>
                <input
                  type="text"
                  placeholder="projects/<gcp-id>/topics/<name>"
                  value={topicName}
                  onChange={(e) => setTopicName(e.target.value)}
                  className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-white/80 placeholder:text-white/25"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-0.5 text-[11px]">
                  <span className="text-white/60">Audience</span>
                  <input
                    type="text"
                    placeholder="https://your.app/api/…"
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                    className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-white/80 placeholder:text-white/25"
                  />
                </label>
                <label className="block space-y-0.5 text-[11px]">
                  <span className="text-white/60">Push service account</span>
                  <input
                    type="text"
                    placeholder="…@…iam.gserviceaccount.com"
                    value={pushServiceAccount}
                    onChange={(e) => setPushServiceAccount(e.target.value)}
                    className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-white/80 placeholder:text-white/25"
                  />
                </label>
              </div>
              <label className="block space-y-0.5 text-[11px]">
                <span className="text-white/60">Label IDs (comma-separated)</span>
                <input
                  type="text"
                  placeholder="INBOX"
                  value={labelIds}
                  onChange={(e) => setLabelIds(e.target.value)}
                  className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-white/80 placeholder:text-white/25"
                />
              </label>
            </div>
          )}

          <label className="block space-y-0.5 text-[11px]">
            <span className="text-white/60">Event type filter (comma-separated; empty = all)</span>
            <input
              type="text"
              placeholder="new_email, new_email_history"
              value={eventTypesRaw}
              onChange={(e) => setEventTypesRaw(e.target.value)}
              className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-white/80 placeholder:text-white/25"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={saveConfig}
              disabled={busy}
              className="rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              Save config
            </button>
            <button
              type="button"
              onClick={() => doAction("rotate")}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              <KeyRound size={12} /> Rotate secret
            </button>
            <button
              type="button"
              onClick={() => {
                if (!confirm("Delete webhook configuration and secret?")) return;
                void doAction("delete");
              }}
              disabled={busy || (!snapshot?.hasSecret && !snapshot?.config)}
              className="inline-flex items-center gap-1.5 rounded border border-red-400/40 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-40"
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>

          {testResult && <p className="text-[11px] text-white/70">{testResult}</p>}

          {error && (
            <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2 text-[11px] text-red-200">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!connected && (
            <p className="text-[11px] text-white/40">
              Connect the integration first to enable webhooks.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
