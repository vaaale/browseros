"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { PROVIDERS, PROVIDER_LIST, type ProviderType } from "@/lib/agent/provider-meta";

export function FirstRunWizard() {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderType>("anthropic");
  const [model, setModel] = useState(PROVIDERS.anthropic.defaultModel);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [harnessUrl, setHarnessUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/system/setup")
      .then((r) => r.json())
      .then((d) => setOpen(!!d.firstRun))
      .catch(() => {});
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        const harness = (d.schemas ?? []).find((s: { namespace: string }) => s.namespace === "dev-harness");
        if (harness) setHarnessUrl(String(harness.values.url ?? ""));
      })
      .catch(() => {});
  }, []);

  const onProvider = (p: ProviderType) => {
    setProvider(p);
    setModel(PROVIDERS[p].defaultModel);
    setBaseUrl(PROVIDERS[p].defaultBaseUrl ?? "");
  };

  const finish = async () => {
    setSaving(true);
    try {
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "ai-provider", values: { provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) } }),
      });
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "dev-harness", values: { url: harnessUrl } }),
      });
      await fetch("/api/system/setup", { method: "POST" });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const meta = PROVIDERS[provider];

  return (
    <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[460px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#15171e] p-6 text-sm shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={18} className="text-violet-300" />
          <h2 className="text-base font-semibold">Welcome to BrowserOS</h2>
        </div>
        <p className="mb-4 text-xs text-white/50">Configure your AI model and (optionally) the Claude dev harness to get started.</p>

        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-white/50">AI Provider</h3>
          <div className="grid grid-cols-[110px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">Provider</label>
            <select value={provider} onChange={(e) => onProvider(e.target.value as ProviderType)} className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none">
              {PROVIDER_LIST.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <label className="text-xs text-white/60">Model</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none" />
            <label className="text-xs text-white/60">Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={meta.baseUrlPlaceholder} className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none" />
            <label className="text-xs text-white/60">API key</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={meta.keyRequired ? "Required" : "Optional for local"} className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none" />
          </div>

          <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-white/50">Claude Dev Harness (optional)</h3>
          <div className="grid grid-cols-[110px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">Harness URL</label>
            <input value={harnessUrl} onChange={(e) => setHarnessUrl(e.target.value)} placeholder="http://host:7272/mcp" className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none" />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setOpen(false)} className="rounded px-3 py-1.5 text-xs text-white/60 hover:bg-white/10">Skip</button>
          <button onClick={finish} disabled={saving} className="rounded bg-violet-500/30 px-4 py-1.5 text-xs font-medium text-violet-100 hover:bg-violet-500/40 disabled:opacity-40">
            {saving ? "Saving…" : "Finish setup"}
          </button>
        </div>
      </div>
    </div>
  );
}
