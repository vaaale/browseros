"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, XCircle, RefreshCw, KeyRound, Link as LinkIcon, AlertTriangle, HelpCircle } from "lucide-react";
import { PROVIDERS, PROVIDER_LIST, type ProviderType, type EmbedAvailability } from "@/lib/agent/provider-meta";

interface ConfigView {
  provider: ProviderType;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  maxTokens?: number;
  maxInputTokens?: number;
  embedBaseUrl: string;
  hasEmbeddingKey: boolean;
  embedModel: string;
  embeddingsEnabled: boolean;
}

const EMBED_STATUS: Record<EmbedAvailability, { label: string; className: string }> = {
  available: { label: "embeddings: available", className: "text-emerald-300" },
  unsupported: { label: "embeddings: not supported from this endpoint", className: "text-amber-300" },
  unknown: { label: "embeddings: status unknown — test the connection", className: "text-white/50" },
};

function EmbedStatusIcon({ status }: { status: EmbedAvailability }) {
  if (status === "available") return <CheckCircle2 size={13} />;
  if (status === "unsupported") return <AlertTriangle size={13} />;
  return <HelpCircle size={13} />;
}

export function ProviderSettings() {
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  // Embeddings subsection — the base URL / key inputs follow the same
  // "blank = unchanged, type-to-set" contract as the LLM API key above: the
  // resolved (fallback-applied) value comes back from the server, never the
  // raw override, so we track "touched" locally rather than prefilling.
  const [embedUrlDraft, setEmbedUrlDraft] = useState("");
  const [embedUrlTouched, setEmbedUrlTouched] = useState(false);
  const [embedKeyDraft, setEmbedKeyDraft] = useState("");
  const [embedAvailability, setEmbedAvailability] = useState<EmbedAvailability>("unknown");
  const [embedTestError, setEmbedTestError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/agent/provider")
      .then((r) => r.json())
      .then((d) => {
        setCfg(d.config);
        setEmbedAvailability(PROVIDERS[d.config.provider as ProviderType]?.embedAvailability ?? "unknown");
      })
      .catch(() => {});
  }, []);

  const fetchModels = useCallback(
    async (provider: ProviderType, baseUrl: string, keyOverride: string) => {
      const seq = ++fetchSeq.current;
      setModelsLoading(true);
      setModelsError(null);
      try {
        const params = new URLSearchParams();
        if (baseUrl) params.set("baseUrl", baseUrl);
        if (keyOverride) params.set("apiKey", keyOverride);
        const qs = params.toString();
        const res = await fetch(`/api/agent/provider/models${qs ? `?${qs}` : ""}`);
        const data = (await res.json()) as { models?: string[]; error?: string };
        if (seq !== fetchSeq.current) return; // stale response
        setAvailableModels(data.models ?? []);
        setModelsError(data.error ?? null);
      } catch (err) {
        if (seq !== fetchSeq.current) return;
        setAvailableModels([]);
        setModelsError((err as Error).message);
      } finally {
        if (seq === fetchSeq.current) setModelsLoading(false);
      }
    },
    [],
  );

  // Debounced refetch when provider, baseUrl, or unsaved apiKey changes.
  useEffect(() => {
    if (!cfg) return;
    const handle = setTimeout(() => {
      fetchModels(cfg.provider, cfg.baseUrl, apiKey);
    }, 500);
    return () => clearTimeout(handle);
  }, [cfg?.provider, cfg?.baseUrl, apiKey, fetchModels, cfg]);

  if (!cfg) return <p className="text-xs text-white/40">Loading provider settings…</p>;

  const meta = PROVIDERS[cfg.provider];

  const onProviderChange = (provider: ProviderType) => {
    const m = PROVIDERS[provider];
    setCfg({
      ...cfg,
      provider,
      model: m.defaultModel,
      baseUrl: m.defaultBaseUrl ?? "",
      embedModel: m.defaultEmbedModel ?? "",
    });
    setStatus(null);
    setAvailableModels([]);
    setModelsError(null);
    setEmbedUrlDraft("");
    setEmbedUrlTouched(false);
    setEmbedKeyDraft("");
    setEmbedTestError(null);
    setEmbedAvailability(m.embedAvailability);
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
          // `null` clears the field (provider default), otherwise send the number.
          maxTokens: cfg.maxTokens ?? null,
          maxInputTokens: cfg.maxInputTokens ?? null,
          ...(apiKey ? { apiKey } : {}),
          embeddings: {
            // Model is always known raw (bound directly, like the main model
            // field) — always send it. Base URL / key are only sent when the
            // user actually touched them this session (per-field fallback).
            model: cfg.embedModel,
            ...(embedUrlTouched ? { baseUrl: embedUrlDraft } : {}),
            ...(embedKeyDraft ? { apiKey: embedKeyDraft } : {}),
          },
        }),
      }).then((r) => r.json());
      if (res.error) setStatus({ ok: false, msg: res.error });
      else {
        setCfg(res.config);
        setApiKey("");
        setEmbedUrlDraft("");
        setEmbedUrlTouched(false);
        setEmbedKeyDraft("");
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
      if (res.embeddings) {
        setEmbedAvailability(res.embeddings.available ? "available" : "unsupported");
        setEmbedTestError(res.embeddings.available ? null : res.embeddings.error ?? null);
      }
    } finally {
      setTesting(false);
    }
  };

  const refreshModels = () => fetchModels(cfg.provider, cfg.baseUrl, apiKey);

  const embedKeySet = cfg.hasEmbeddingKey || !!embedKeyDraft;
  const embedStatusMeta = EMBED_STATUS[embedAvailability];

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
        <div className="flex items-center gap-1.5">
          <input
            list="provider-models"
            value={cfg.model}
            onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
            placeholder={meta.defaultModel}
            className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
          />
          <datalist id="provider-models">
            {availableModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={refreshModels}
            disabled={modelsLoading}
            title="Refresh model list"
            className="flex items-center gap-1 rounded border border-white/10 bg-black/20 px-2 py-1.5 text-xs hover:bg-white/10 disabled:opacity-40"
          >
            {modelsLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          </button>
        </div>

        <span />
        <p className="text-[11px] text-white/40">
          {modelsLoading
            ? "Loading models…"
            : modelsError
              ? <span className="text-amber-300/80">Couldn’t fetch models: {modelsError}</span>
              : availableModels.length > 0
                ? `${availableModels.length} model${availableModels.length === 1 ? "" : "s"} available — start typing to filter, or enter a custom name.`
                : "No models discovered — you can still type a custom model name."}
        </p>

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
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={cfg.hasApiKey ? "•••••••• (saved — type to replace)" : meta.keyRequired ? "Required" : "Optional for local"}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        />

        <label className="text-xs text-white/60">Max output tokens</label>
        <input
          type="number"
          min={0}
          value={cfg.maxTokens ?? ""}
          onChange={(e) => setCfg({ ...cfg, maxTokens: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="provider default (leave blank)"
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

      {/* ============ Embeddings subsection (028-memory-curation-retrieval) ============ */}
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-white/50">Embeddings</h3>
          <span className="rounded border border-dashed border-sky-400/40 bg-sky-400/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
            new
          </span>
          <span className={`ml-auto flex items-center gap-1 text-[11px] ${embedStatusMeta.className}`}>
            <EmbedStatusIcon status={embedAvailability} />
            {embedStatusMeta.label}
          </span>
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">Base URL</label>
            <input
              value={embedUrlDraft}
              onChange={(e) => {
                setEmbedUrlDraft(e.target.value);
                setEmbedUrlTouched(true);
              }}
              placeholder={`Uses: ${cfg.embedBaseUrl || "(none set above)"}`}
              className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <div className="grid grid-cols-[120px_1fr] items-start gap-2">
            <span />
            <p className="text-[11px] text-white/40">
              {embedUrlTouched && embedUrlDraft
                ? "Custom endpoint — requests go to the URL above, not the LLM base URL."
                : "Leave blank to use the LLM provider's base URL above."}
            </p>
          </div>

          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <label className="text-xs text-white/60">API key</label>
            <div className="flex items-center gap-2">
              <input
                type="password"
                autoComplete="new-password"
                value={embedKeyDraft}
                onChange={(e) => setEmbedKeyDraft(e.target.value)}
                placeholder={embedKeySet ? "•••••••• (set — type to replace)" : "Blank — uses the LLM provider's API key"}
                className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
              />
              <span className="shrink-0 text-[11px]">
                {embedKeySet ? (
                  <span className="flex items-center gap-1 text-emerald-300">
                    <KeyRound size={12} /> set
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-white/40">
                    <LinkIcon size={12} /> fallback
                  </span>
                )}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-[120px_1fr] items-start gap-2">
            <span />
            <p className="text-[11px] text-white/40">
              {embedKeySet
                ? "A separate embedding key is in use. Stored as a secret; the value is never displayed."
                : "Leave blank to use the LLM provider's API key above."}
            </p>
          </div>

          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-white/60">
              Model
              <span className="rounded bg-white/10 px-1 text-[10px] font-normal text-white/50">required</span>
            </label>
            <input
              value={cfg.embedModel}
              onChange={(e) => setCfg({ ...cfg, embedModel: e.target.value })}
              placeholder={meta.embedModelPlaceholder || meta.defaultEmbedModel || "embedding model"}
              className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <div className="grid grid-cols-[120px_1fr] items-start gap-2">
            <span />
            <p className="text-[11px] text-white/40">
              {cfg.embedModel && cfg.embedModel !== meta.defaultEmbedModel ? (
                <>Custom model — <code className="text-white/60">{cfg.embedModel}</code> in use.</>
              ) : meta.defaultEmbedModel ? (
                <>Required — defaults to <code className="text-white/60">{meta.defaultEmbedModel}</code> for {meta.label}.</>
              ) : (
                <span className="text-amber-200/80">{meta.embedModelNote || "Required — set a model served by your endpoint."}</span>
              )}
            </p>
          </div>
          {embedTestError && (
            <p className="text-[11px] text-amber-300/80">{embedTestError}</p>
          )}
        </div>
      </div>
      {/* ============ /Embeddings ============ */}

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
        Used by the Assistant chat, sub-agents, memory reflection, and the dev harness fallback. The{" "}
        <span className="text-white/60">embeddings</span> endpoint powers dense (semantic) memory retrieval; if the
        provider can&apos;t serve embeddings, retrieval degrades to keyword + recency + importance.
      </p>
    </div>
  );
}
