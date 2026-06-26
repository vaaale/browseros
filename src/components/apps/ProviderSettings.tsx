"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { PROVIDERS, PROVIDER_LIST, type ProviderType } from "@/lib/agent/provider-meta";

interface ConfigView {
  provider: ProviderType;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  maxTokens: number;
  maxInputTokens?: number;
}

export function ProviderSettings() {
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    fetch("/api/agent/provider")
      .then((r) => r.json())
      .then((d) => setCfg(d.config))
      .catch(() => {});
  }, []);

  if (!cfg) return <p className="text-xs text-white/40">Loading provider settings…</p>;

  const meta = PROVIDERS[cfg.provider];

  const onProviderChange = (provider: ProviderType) => {
    const m = PROVIDERS[provider];
    setCfg({ ...cfg, provider, model: m.defaultModel, baseUrl: m.defaultBaseUrl ?? "" });
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/agent/provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          maxTokens: cfg.maxTokens,
          maxInputTokens: cfg.maxInputTokens ?? null,
          ...(apiKey ? { apiKey } : {}),
        }),
      }).then((r) => r.json());
      if (res.error) setStatus({ ok: false, msg: res.error });
      else {
        setCfg(res.config);
        setApiKey("");
        setStatus({ ok: true, msg: "Saved." });
      }
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const res = await fetch("/api/agent/provider/test", { method: "POST" }).then((r) => r.json());
      setStatus(
        res.ok
          ? { ok: true, msg: `Connected to ${res.provider} (${res.model}). Reply: ${res.sample || "—"}` }
          : { ok: false, msg: res.error || "Test failed" },
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[120px_1fr] items-center gap-2">
        <label className="text-xs text-white/60">Provider</label>
        <select
          value={cfg.provider}
          onChange={(e) => onProviderChange(e.target.value as ProviderType)}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        >
          {PROVIDER_LIST.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <label className="text-xs text-white/60">Model</label>
        <input
          value={cfg.model}
          onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
          placeholder={meta.defaultModel}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        />

        <label className="text-xs text-white/60">Base URL</label>
        <input
          value={cfg.baseUrl}
          onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
          placeholder={meta.baseUrlPlaceholder}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        />

        <label className="text-xs text-white/60">API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={cfg.hasApiKey ? "•••••••• (saved — type to replace)" : meta.keyRequired ? "Required" : "Optional for local"}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        />

        <label className="text-xs text-white/60">Max output tokens</label>
        <input
          type="number"
          min={256}
          value={cfg.maxTokens}
          onChange={(e) => setCfg({ ...cfg, maxTokens: Number(e.target.value) || 0 })}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        />

        <label className="text-xs text-white/60">Context window</label>
        <input
          type="number"
          min={0}
          value={cfg.maxInputTokens ?? ""}
          onChange={(e) => setCfg({ ...cfg, maxInputTokens: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="model default (e.g. 256000)"
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={test}
          disabled={testing}
          className="flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-40"
        >
          {testing && <Loader2 size={13} className="animate-spin" />} Test connection
        </button>
        {status && (
          <span className={`flex items-center gap-1 text-xs ${status.ok ? "text-emerald-300" : "text-red-300"}`}>
            {status.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
            {status.msg}
          </span>
        )}
      </div>
      <p className="text-[11px] text-white/40">
        Used by the Assistant chat, sub-agents, memory reflection, and the dev harness fallback.
      </p>
    </div>
  );
}
