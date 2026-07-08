"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Bot, Save } from "lucide-react";

// Configure agent-routing for the Telegram bot service.
//
// The router (src/lib/integrations/services/telegram/agent-router.ts) reads
// state.services.bot.config.agentConfig. This UI:
//   1. Lists installed sub-agents via /api/subagents so the user picks one.
//   2. GET current agentConfig from /api/integrations/telegram (via useIntegrations
//      state we get through onRefresh) — but to keep this component self-
//      contained we fetch /api/integrations/telegram directly on mount.
//   3. PATCH { services: { bot: { config: { agentConfig: {...} } } } } to save.

interface SubAgentSummary {
  id: string;
  name: string;
  description?: string;
}

interface AgentConfigState {
  enabled: boolean;
  agentId: string;
  mode: "auto_reply" | "manual";
  contextDepth: number;
  fallbackMessage: string;
}

interface IntegrationDetailResponse {
  state?: {
    services?: {
      bot?: {
        config?: {
          agentConfig?: Partial<AgentConfigState>;
        };
      };
    };
  };
}

const DEFAULTS: AgentConfigState = {
  enabled: false,
  agentId: "",
  mode: "auto_reply",
  contextDepth: 10,
  fallbackMessage: "",
};

function normalize(input: Partial<AgentConfigState> | undefined): AgentConfigState {
  const cfg = input ?? {};
  return {
    enabled: cfg.enabled === true,
    agentId: typeof cfg.agentId === "string" ? cfg.agentId : "",
    mode: cfg.mode === "manual" ? "manual" : "auto_reply",
    contextDepth:
      typeof cfg.contextDepth === "number" && Number.isFinite(cfg.contextDepth)
        ? Math.max(1, Math.min(50, Math.floor(cfg.contextDepth)))
        : DEFAULTS.contextDepth,
    fallbackMessage: typeof cfg.fallbackMessage === "string" ? cfg.fallbackMessage : "",
  };
}

export interface TelegramBotAgentConfigProps {
  /** Bump this after PATCHing so the parent view refreshes its cached summary. */
  onChange?: () => void | Promise<void>;
}

export function TelegramBotAgentConfig({ onChange }: TelegramBotAgentConfigProps) {
  const [config, setConfig] = useState<AgentConfigState>(DEFAULTS);
  const [initial, setInitial] = useState<AgentConfigState>(DEFAULTS);
  const [agents, setAgents] = useState<SubAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [detailRes, agentsRes] = await Promise.all([
        fetch("/api/integrations/telegram"),
        fetch("/api/subagents"),
      ]);
      const detail = (await detailRes.json()) as IntegrationDetailResponse;
      const agentBody = (await agentsRes.json()) as { subAgents?: SubAgentSummary[] };
      const next = normalize(detail.state?.services?.bot?.config?.agentConfig);
      setConfig(next);
      setInitial(next);
      setAgents(agentBody.subAgents ?? []);
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

  const dirty = useMemo(() => {
    return (
      config.enabled !== initial.enabled ||
      config.agentId !== initial.agentId ||
      config.mode !== initial.mode ||
      config.contextDepth !== initial.contextDepth ||
      config.fallbackMessage !== initial.fallbackMessage
    );
  }, [config, initial]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await fetch("/api/integrations/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          services: {
            bot: {
              config: {
                agentConfig: {
                  enabled: config.enabled,
                  agentId: config.agentId.trim(),
                  mode: config.mode,
                  contextDepth: config.contextDepth,
                  fallbackMessage: config.fallbackMessage,
                },
              },
            },
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setInitial(config);
      setNotice("Saved.");
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [config, onChange]);

  const disabledForEdit = loading || busy;
  const disabledForSave = disabledForEdit || !dirty;
  const missingAgent =
    config.enabled && config.agentId.trim() !== "" && !agents.some((a) => a.id === config.agentId);

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex items-center gap-2">
        <Bot size={14} className="text-white/50" />
        <h4 className="text-[13px] font-semibold text-white">Agent auto-reply</h4>
      </div>
      <p className="mb-3 text-[11px] text-white/60">
        When enabled, every incoming text message is routed through the selected sub-agent and its
        reply is posted back to the same chat. Prior turns are kept in a per-chat rolling context
        (up to 20 messages). Notifications still fire, so nothing else in BOS changes.
      </p>

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-[12px] text-white/85">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
            disabled={disabledForEdit}
            className="accent-violet-500"
          />
          Enable agent routing
        </label>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Sub-agent
          </label>
          <select
            value={config.agentId}
            onChange={(e) => setConfig((c) => ({ ...c, agentId: e.target.value }))}
            disabled={disabledForEdit || !config.enabled}
            className="w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-[12px] text-white focus:border-violet-400 focus:outline-none disabled:opacity-50"
          >
            <option value="">Select an agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
            {missingAgent && (
              <option value={config.agentId} disabled>
                {config.agentId} (missing)
              </option>
            )}
          </select>
          {missingAgent && (
            <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-300">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              The configured agent no longer exists. Pick another or disable routing.
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Mode
          </label>
          <select
            value={config.mode}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                mode: e.target.value === "manual" ? "manual" : "auto_reply",
              }))
            }
            disabled={disabledForEdit || !config.enabled}
            className="w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-[12px] text-white focus:border-violet-400 focus:outline-none disabled:opacity-50"
          >
            <option value="auto_reply">Auto-reply</option>
            <option value="manual">Manual (no auto-reply — routing off)</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Context depth (1–50)
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={config.contextDepth}
            onChange={(e) => {
              const v = Number(e.target.value);
              setConfig((c) => ({
                ...c,
                contextDepth: Number.isFinite(v) ? Math.max(1, Math.min(50, Math.floor(v))) : c.contextDepth,
              }));
            }}
            disabled={disabledForEdit || !config.enabled}
            className="w-24 rounded border border-white/15 bg-black/30 px-2 py-1.5 text-[12px] text-white focus:border-violet-400 focus:outline-none disabled:opacity-50"
          />
          <span className="ml-2 text-[11px] text-white/50">
            prior turns injected into each prompt
          </span>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Fallback message
          </label>
          <input
            type="text"
            value={config.fallbackMessage}
            onChange={(e) => setConfig((c) => ({ ...c, fallbackMessage: e.target.value }))}
            placeholder="Optional — sent when the agent errors. Leave blank to stay silent."
            disabled={disabledForEdit || !config.enabled}
            className="w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-[12px] text-white placeholder-white/25 focus:border-violet-400 focus:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-1.5 rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && !error && (
        <div className="mt-3 rounded border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
          {notice}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={disabledForSave}
          className="inline-flex items-center gap-1.5 rounded bg-violet-500/80 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
        >
          <Save size={12} /> {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
