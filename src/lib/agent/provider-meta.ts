// Provider metadata shared by client (Settings UI) and server. No secrets here.

export type ProviderType = "anthropic" | "openai" | "openai-codex" | "openai-compatible" | "openai-responses";
export type ProviderFamily = "anthropic" | "openai";

/** Embedding availability for a provider's default (LLM) endpoint, before any
 *  Test-connection probe — a starting inference, not a live measurement
 *  (028-memory-curation-retrieval, T3). */
export type EmbedAvailability = "available" | "unsupported" | "unknown";

export interface ProviderMeta {
  id: ProviderType;
  label: string;
  family: ProviderFamily;
  defaultModel: string;
  defaultBaseUrl?: string;
  baseUrlPlaceholder: string;
  /** Whether an API key is typically required (local servers often don't need one). */
  keyRequired: boolean;
  /** Per-provider default embedding model — undefined when there is no universal
   *  default (the user must pick one, e.g. a local OpenAI-compatible server). */
  defaultEmbedModel?: string;
  /** UI-hint-only placeholder shown in the (empty) embedding model input when
   *  there's no `defaultEmbedModel` — NOT auto-filled or persisted (spec
   *  Assumptions: "a placeholder ... is only a UI hint, not a stored default"). */
  embedModelPlaceholder?: string;
  /** Explanatory note shown under the embedding model field when the provider
   *  has no first-party embeddings (e.g. Anthropic). */
  embedModelNote?: string;
  /** Inferred embedding availability for this provider's default endpoint. */
  embedAvailability: EmbedAvailability;
}

export const PROVIDERS: Record<ProviderType, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    family: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    baseUrlPlaceholder: "https://api.anthropic.com (default)",
    keyRequired: true,
    embedModelNote:
      "No standard Anthropic embedding model — set an OpenAI-compatible model, or leave blank to disable embeddings (retrieval degrades to keyword + recency + importance).",
    embedAvailability: "unsupported",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    family: "openai",
    defaultModel: "gpt-4o",
    baseUrlPlaceholder: "https://api.openai.com/v1 (default)",
    keyRequired: true,
    defaultEmbedModel: "text-embedding-3-small",
    embedAvailability: "available",
  },
  "openai-codex": {
    id: "openai-codex",
    label: "OpenAI Codex",
    family: "openai",
    defaultModel: "gpt-5-codex",
    baseUrlPlaceholder: "https://api.openai.com/v1 (default)",
    keyRequired: true,
    defaultEmbedModel: "text-embedding-3-small",
    embedAvailability: "available",
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "Local (OpenAI-compatible)",
    family: "openai",
    defaultModel: "local-model",
    defaultBaseUrl: "http://localhost:1234/v1",
    baseUrlPlaceholder: "http://localhost:1234/v1",
    keyRequired: false,
    embedModelPlaceholder: "nomic-embed-text",
    embedAvailability: "unknown",
  },
  "openai-responses": {
    id: "openai-responses",
    label: "OpenAI Responses API",
    family: "openai",
    defaultModel: "gpt-4o",
    defaultBaseUrl: "http://localhost:1234/v1",
    baseUrlPlaceholder: "http://localhost:1234/v1 (or leave blank for api.openai.com)",
    keyRequired: false,
    defaultEmbedModel: "text-embedding-3-small",
    embedAvailability: "unknown",
  },
};

export const PROVIDER_LIST: ProviderMeta[] = Object.values(PROVIDERS);

export function familyOf(provider: ProviderType): ProviderFamily {
  return PROVIDERS[provider]?.family ?? "openai";
}

// Known OpenAI-compatible endpoint suffixes a user might accidentally paste as
// the base URL instead of the API root.  Strip them before constructing derived
// URLs (e.g. /models, /chat/completions) so the right path is always appended.
const ENDPOINT_SUFFIXES = [
  "/responses",
  "/chat/completions",
  "/completions",
  "/embeddings",
  "/models",
];

/** Normalise a provider base URL: trim trailing slashes and strip any trailing
 *  endpoint path so callers always get the bare API root. */
export function normalizeApiBase(rawBase: string): string {
  let base = rawBase.replace(/\/+$/, "");
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, base.length - suffix.length);
      break;
    }
  }
  return base;
}
