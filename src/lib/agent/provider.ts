import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { familyOf, PROVIDERS, type ProviderType } from "./provider-meta";

const FILE = path.join(dataDir(), "provider.json");

export const DEFAULT_MAX_TOKENS = 65535;

/** Embedding endpoint config (028-memory-curation-retrieval, T3/FR-009). Every
 *  field independently falls back per-field (empty ⇒ use the LLM provider's
 *  value) — see resolveEmbeddingConfig. */
export interface EmbeddingConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface ProviderConfig {
  provider: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /** Max tokens the model may generate per response. Omit to let the provider use its own default. */
  maxTokens?: number;
  /** Context window (max input tokens) used for trimming. Optional. */
  maxInputTokens?: number;
  embeddings?: EmbeddingConfig;
}

export interface ProviderConfigView {
  provider: ProviderType;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  maxTokens?: number;
  maxInputTokens?: number;
  /** The RESOLVED embedding base URL (safe to show — not a secret): the
   *  configured embeddings.baseUrl, or the LLM base URL when left blank. */
  embedBaseUrl: string;
  /** Whether a SEPARATE embedding API key is set (never the key itself). When
   *  false, the embedding client falls back to the LLM provider's key (whose
   *  own presence is `hasApiKey`). */
  hasEmbeddingKey: boolean;
  /** The configured embedding model (independent of the LLM model; blank ⇒ disabled). */
  embedModel: string;
  /** Resolved: a non-blank model AND a non-anthropic-family provider. */
  embeddingsEnabled: boolean;
}

/** Per-field embedding fallback resolution (FR-010, design §5.1):
 *    baseUrl  = embeddings.baseUrl  || llm.baseUrl
 *    apiKey   = embeddings.apiKey   || llm.apiKey
 *    model    = embeddings.model    || undefined   (independent; no fallback)
 *    enabled  = model is non-blank AND NOT (falling back to an Anthropic base
 *               URL with no /embeddings) — a pure-Anthropic provider with no
 *               embedding-base-URL override has nothing to fall back to
 *               (spec Edge Case: "pure-Anthropic provider"), but a custom
 *               embeddings.baseUrl pointed at an OpenAI-compatible server
 *               re-enables it (the edge case's documented workaround) even
 *               while the LLM stays on Anthropic. */
export function resolveEmbeddingConfig(c: ProviderConfig): { baseUrl?: string; apiKey?: string; model?: string; enabled: boolean } {
  const baseUrl = c.embeddings?.baseUrl || c.baseUrl || undefined;
  const apiKey = c.embeddings?.apiKey || c.apiKey || undefined;
  const model = c.embeddings?.model || undefined;
  const fallingBackToAnthropic = !c.embeddings?.baseUrl && familyOf(c.provider) === "anthropic";
  const enabled = !!model && !fallingBackToAnthropic;
  return { baseUrl, apiKey, model, enabled };
}

// Backwards-compatible defaults derived from environment variables.
function envConfig(): ProviderConfig {
  const envMax = process.env.BOS_MAX_TOKENS ? Number(process.env.BOS_MAX_TOKENS) : undefined;
  return {
    provider: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
    model: process.env.BOS_AGENT_MODEL || PROVIDERS.anthropic.defaultModel,
    maxTokens: envMax && envMax > 0 ? envMax : undefined,
    maxInputTokens: process.env.BOS_MAX_INPUT_TOKENS ? Number(process.env.BOS_MAX_INPUT_TOKENS) : undefined,
  };
}

/** Full config including the secret — server-only use (LLM clients, adapters).
 *  `modelOverride` (025-agent-delegation-v2): a named agent's `model` field
 *  substitutes for the resolved model string only — provider/apiKey/baseUrl
 *  are always the single configured provider, never switched per-agent. */
export async function getProviderConfig(modelOverride?: string): Promise<ProviderConfig> {
  const base = envConfig();
  try {
    const saved = JSON.parse(await fs.readFile(FILE, "utf8")) as Partial<ProviderConfig>;
    const provider = saved.provider ?? base.provider;
    return {
      provider,
      apiKey: saved.apiKey ?? base.apiKey,
      baseUrl: saved.baseUrl ?? base.baseUrl,
      model: modelOverride || saved.model || PROVIDERS[provider]?.defaultModel || base.model,
      maxTokens: "maxTokens" in saved
        ? (saved.maxTokens && saved.maxTokens > 0 ? saved.maxTokens : undefined)
        : base.maxTokens,
      maxInputTokens: saved.maxInputTokens ?? base.maxInputTokens,
      embeddings: saved.embeddings,
    };
  } catch {
    return modelOverride ? { ...base, model: modelOverride } : base;
  }
}

/** Safe view for the UI — never exposes either API key (FR-011). */
export async function getProviderConfigView(): Promise<ProviderConfigView> {
  const c = await getProviderConfig();
  const resolved = resolveEmbeddingConfig(c);
  return {
    provider: c.provider,
    baseUrl: c.baseUrl ?? "",
    model: c.model,
    hasApiKey: !!c.apiKey,
    maxTokens: c.maxTokens,
    maxInputTokens: c.maxInputTokens,
    embedBaseUrl: resolved.baseUrl ?? "",
    hasEmbeddingKey: !!c.embeddings?.apiKey,
    embedModel: c.embeddings?.model ?? "",
    embeddingsEnabled: resolved.enabled,
  };
}

export async function updateProviderConfig(patch: Partial<ProviderConfig>): Promise<ProviderConfigView> {
  const current = await getProviderConfig();
  const provider = patch.provider ?? current.provider;
  // Embeddings merge PER-FIELD (design S3) — "" clears that field, undefined
  // leaves it unchanged — mirroring the flat apiKey/baseUrl convention below.
  // NOT `patch.embeddings ?? current.embeddings` (all-or-nothing), which would
  // force a full-object send and break independent per-field fallback.
  const embeddingsPatch = patch.embeddings;
  const nextEmbeddings: EmbeddingConfig | undefined = embeddingsPatch
    ? {
        baseUrl: embeddingsPatch.baseUrl === undefined ? current.embeddings?.baseUrl : embeddingsPatch.baseUrl || undefined,
        apiKey: embeddingsPatch.apiKey === undefined ? current.embeddings?.apiKey : embeddingsPatch.apiKey || undefined,
        model: embeddingsPatch.model === undefined ? current.embeddings?.model : embeddingsPatch.model || undefined,
      }
    : current.embeddings;
  const next: ProviderConfig = {
    provider,
    // An explicit empty string clears the key; undefined leaves it unchanged.
    apiKey: patch.apiKey === undefined ? current.apiKey : patch.apiKey || undefined,
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl || undefined,
    model: patch.model || (patch.provider ? PROVIDERS[provider].defaultModel : current.model),
    // `null` or 0 clears the value; undefined leaves it unchanged.
    maxTokens: "maxTokens" in patch
      ? (typeof patch.maxTokens === "number" && patch.maxTokens > 0 ? patch.maxTokens : undefined)
      : current.maxTokens,
    maxInputTokens:
      patch.maxInputTokens === undefined ? current.maxInputTokens : patch.maxInputTokens || undefined,
    embeddings: nextEmbeddings,
  };
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await writeFileAtomic(FILE, JSON.stringify(next, null, 2));
  return getProviderConfigView();
}

export async function hasCredentials(): Promise<boolean> {
  const c = await getProviderConfig();
  return !!c.apiKey || c.provider === "openai-compatible" || c.provider === "openai-responses";
}
