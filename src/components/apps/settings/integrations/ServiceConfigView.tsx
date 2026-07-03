"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Bell, Copy, Globe, RefreshCw, Save, ShieldCheck } from "lucide-react";
import type { IntegrationSummary } from "./useIntegrations";
import { scopeLabel } from "./useIntegrations";
import { ScopeToggle } from "./ScopeToggle";
import { PollingSection } from "./PollingSection";
import { WebhookSection } from "./WebhookSection";

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  }, [drafts, initialOverrides, enabledDraft, item.manifest.id, onPatch, serviceId, svcState]);

  const cancel = useCallback(() => {
    if (dirty && !confirm("Discard unsaved changes to scope toggles?")) return;
    setDrafts(initialOverrides);
    setEnabledDraft(svcState?.enabled !== false);
    setError(undefined);
  }, [dirty, initialOverrides, svcState?.enabled]);

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

      {/* Polling (Phase 2) */}
      <PollingSection item={item} serviceId={serviceId} onPatch={onPatch} />

      {/* Webhooks (Phase 2) */}
      <WebhookSection item={item} serviceId={serviceId} />
    </div>
  );
}

// Re-export the icons used by sub-sections so the barrel-free imports stay tidy.
export const _icons = { Bell, Globe, Copy, ShieldCheck, RefreshCw };
