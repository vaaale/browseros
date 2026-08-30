"use client";

import { useEffect, useRef } from "react";
import { PROVIDERS, PROVIDER_LIST, type ProviderType } from "@/lib/agent/provider-meta";

interface Props {
  provider: ProviderType;
  model: string;
  baseUrl: string;
  apiKey: string;
  availableModels: string[];
  onProvider: (p: ProviderType) => void;
  onModel: (m: string) => void;
  onBaseUrl: (u: string) => void;
  onApiKey: (k: string) => void;
  onAvailableModels: (m: string[]) => void;
}

export function Step1AiProvider({ provider, model, baseUrl, apiKey, availableModels, onProvider, onModel, onBaseUrl, onApiKey, onAvailableModels }: Props) {
  const fetchSeq = useRef(0);
  const meta = PROVIDERS[provider];

  const handleProvider = (p: ProviderType) => {
    onProvider(p);
    onModel(PROVIDERS[p].defaultModel);
    onBaseUrl(PROVIDERS[p].defaultBaseUrl ?? "");
    onAvailableModels([]);
  };

  useEffect(() => {
    const seq = ++fetchSeq.current;
    const params = new URLSearchParams();
    if (baseUrl) params.set("baseUrl", baseUrl);
    if (apiKey) params.set("apiKey", apiKey);
    const qs = params.toString();
    fetch(`/api/agent/provider/models${qs ? `?${qs}` : ""}`)
      .then((r) => r.json())
      .then((d: { models?: string[] }) => {
        if (seq !== fetchSeq.current) return;
        const models = d.models ?? [];
        onAvailableModels(models);
        if (models.length > 0 && !models.includes(model)) {
          const def = PROVIDERS[provider].defaultModel;
          if (model === def || model === "") onModel(models[0]);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, baseUrl, apiKey]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/50">
        Choose your AI provider and enter credentials. This is required — BOS cannot function without an AI model.
      </p>

      <div className="grid grid-cols-[130px_1fr] items-center gap-x-3 gap-y-2.5">
        <label className="text-xs text-white/60">Provider</label>
        <select
          value={provider}
          onChange={(e) => handleProvider(e.target.value as ProviderType)}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none"
        >
          {PROVIDER_LIST.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <label className="text-xs text-white/60">Model</label>
        <div>
          <input
            value={model}
            onChange={(e) => onModel(e.target.value)}
            list="wizard-step1-models"
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none"
            placeholder="Enter or select a model"
          />
          <datalist id="wizard-step1-models">
            {availableModels.map((m) => <option key={m} value={m} />)}
          </datalist>
        </div>

        <label className="text-xs text-white/60">Base URL</label>
        <input
          value={baseUrl}
          onChange={(e) => onBaseUrl(e.target.value)}
          placeholder={meta.baseUrlPlaceholder}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none"
        />

        <label className="text-xs text-white/60">API key</label>
        <input
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => onApiKey(e.target.value)}
          placeholder={meta.keyRequired ? "Required" : "Optional for local"}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none"
        />
      </div>
    </div>
  );
}
