"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Bell, Globe, Save, RefreshCw } from "lucide-react";
import type { IntegrationSummary } from "./useIntegrations";
import { scopeLabel } from "./useIntegrations";
import { ScopeToggle } from "./ScopeToggle";

type ServiceStateOverrides = Record<string, boolean>;

export interface ServiceConfigViewProps {
  item: IntegrationSummary;
  serviceId: string;
  onPatch: (id: string, body: unknown) => Promise<void>;
}

export function ServiceConfigView({ item, serviceId, onPatch }: ServiceConfigViewProps) {
  const service = item.manifest.services.find((s) => s.id === serviceId);
  const svcState = item.state.services[serviceId];

  // Local drafts of the scope overrides — committed on Save.
  const initialOverrides = useMemo(() => ({ ...item.state.scopeOverrides }), [item.state.scopeOverrides]);
  const [drafts, setDrafts] = useState<ServiceStateOverrides>(initialOverrides);
  const [enabledDraft, setEnabledDraft] = useState<boolean>(svcState?.enabled !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState<string | undefined>();

  useEffect(() => {
    setDrafts(initialOverrides);
    setEnabledDraft(svcState?.enabled !== false);
  }, [initialOverrides, svcState?.enabled]);

  const dirty = useMemo(() => {
    if (enabledDraft !== (svcState?.enabled !== false)) return true;
    const keys = new Set([...Object.keys(initialOverrides), ...Object.keys(drafts)]);
    for (const k of keys) {
      if ((initialOverrides[k] ?? undefined) !== (drafts[k] ?? undefined)) return true;
    }
    return false;
  }, [drafts, initialOverrides, enabledDraft, svcState?.enabled]);

  const granted = new Set(item.state.oauthMeta?.granted_scopes ?? []);

  const setScopeEnabled = useCallback((scope: string, enabled: boolean) => {
    setDrafts((prev) => {
      const next = { ...prev };
      if (enabled) {
        delete next[scope];
      } else {
        next[scope] = false;
      }
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(undefined);
    try {
      // Compare drafts against the initial to build the payload — an "add"
      // is any scope disabled in drafts, a "remove" (back to enabled) is any
      // scope that was previously false but is no longer in drafts.
      const scopeOverridesPatch: Record<string, boolean> = {};
      const keys = new Set([...Object.keys(initialOverrides), ...Object.keys(drafts)]);
      for (const k of keys) {
        const wasFalse = initialOverrides[k] === false;
        const isFalse = drafts[k] === false;
        if (isFalse && !wasFalse) scopeOverridesPatch[k] = false;
        if (!isFalse && wasFalse) scopeOverridesPatch[k] = true;
      }
      await onPatch(item.manifest.id, {
        services: { [serviceId]: { enabled: enabledDraft, config: svcState?.config ?? {} } },
        scopeOverrides: scopeOverridesPatch,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [drafts, initialOverrides, enabledDraft, item.manifest.id, onPatch, serviceId, svcState?.config]);

  const cancel = useCallback(() => {
    if (dirty && !confirm("Discard unsaved changes to scope toggles?")) return;
    setDrafts(initialOverrides);
    setEnabledDraft(svcState?.enabled !== false);
    setError(undefined);
  }, [dirty, initialOverrides, svcState?.enabled]);

  const pollNow = useCallback(async () => {
    setPolling(true);
    setPollResult(undefined);
    try {
      const res = await fetch(
        `/api/integrations/${encodeURIComponent(item.manifest.id)}/services/${encodeURIComponent(serviceId)}/poll`,
        { method: "POST" },
      );
      const body = (await res.json()) as { newMessages?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Poll failed: ${res.status}`);
      setPollResult(`Polled: ${body.newMessages ?? 0} new event${body.newMessages === 1 ? "" : "s"}.`);
    } catch (e) {
      setPollResult(`Error: ${(e as Error).message}`);
    } finally {
      setPolling(false);
    }
  }, [item.manifest.id, serviceId]);

  if (!service) return <p className="text-xs text-white/40">Unknown service.</p>;

  return (
    <div className="space-y-5">
      {/* Service enabled + save/cancel bar */}
      <section className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <label className="flex items-center gap-3 text-[12px]">
          <input
            type="checkbox"
            checked={enabledDraft}
            onChange={(e) => setEnabledDraft(e.target.checked)}
            className="h-3.5 w-3.5 accent-violet-500"
          />
          <span>
            <span className="font-medium">Enable {service.name}</span>
            <span className="ml-2 text-white/50">
              — turning this off keeps credentials but blocks all methods.
            </span>
          </span>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={!dirty || saving}
            className="rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
          >
            <Save size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-400/30 bg-red-500/10 p-2.5 text-[11px] text-red-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Scopes */}
      <section>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Scopes</h4>
        <div className="space-y-1.5">
          {service.scopes.map((scope) => (
            <ScopeToggle
              key={scope}
              scope={scope}
              label={scopeLabel(scope)}
              granted={granted.has(scope)}
              enabled={drafts[scope] !== false}
              onChange={(v) => setScopeEnabled(scope, v)}
            />
          ))}
        </div>
        {!item.state.connected && (
          <p className="mt-2 text-[11px] text-white/40">
            Connect the integration to grant scopes.
          </p>
        )}
      </section>

      {/* Polling (Phase 2) — disabled but visible */}
      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3 opacity-70">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
            <Bell size={12} /> Polling
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-normal normal-case text-white/60">
              Coming in Phase 2
            </span>
          </h4>
          <button
            type="button"
            onClick={pollNow}
            disabled={polling || !item.state.connected}
            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <RefreshCw size={12} /> {polling ? "Polling…" : "Poll now"}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-white/50">
          <label className="space-y-1">
            <span>Interval (seconds)</span>
            <input
              type="number"
              disabled
              defaultValue={300}
              className="w-full cursor-not-allowed rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-white/60"
            />
          </label>
          <label className="space-y-1">
            <span>Query</span>
            <input
              type="text"
              disabled
              defaultValue="in:inbox is:unread"
              className="w-full cursor-not-allowed rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-white/60"
            />
          </label>
        </div>
        {pollResult && <p className="mt-2 text-[11px] text-white/70">{pollResult}</p>}
      </section>

      {/* Webhooks (Phase 2) — disabled placeholder */}
      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3 opacity-70">
        <h4 className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          <Globe size={12} /> Webhooks
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-normal normal-case text-white/60">
            Coming in Phase 2
          </span>
        </h4>
        <p className="text-[11px] text-white/50">
          Push notifications from the provider will land here. No endpoint is registered yet.
        </p>
      </section>
    </div>
  );
}
