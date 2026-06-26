// Provider metadata shared by client (Settings UI) and server. No secrets here.

export type ProviderType = "anthropic" | "openai" | "openai-codex" | "openai-compatible";
export type ProviderFamily = "anthropic" | "openai";

export interface ProviderMeta {
  id: ProviderType;
  label: string;
  family: ProviderFamily;
  defaultModel: string;
  defaultBaseUrl?: string;
  baseUrlPlaceholder: string;
  /** Whether an API key is typically required (local servers often don't need one). */
  keyRequired: boolean;
}

export const PROVIDERS: Record<ProviderType, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    family: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    baseUrlPlaceholder: "https://api.anthropic.com (default)",
    keyRequired: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    family: "openai",
    defaultModel: "gpt-4o",
    baseUrlPlaceholder: "https://api.openai.com/v1 (default)",
    keyRequired: true,
  },
  "openai-codex": {
    id: "openai-codex",
    label: "OpenAI Codex",
    family: "openai",
    defaultModel: "gpt-5-codex",
    baseUrlPlaceholder: "https://api.openai.com/v1 (default)",
    keyRequired: true,
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "Local (OpenAI-compatible)",
    family: "openai",
    defaultModel: "local-model",
    defaultBaseUrl: "http://localhost:1234/v1",
    baseUrlPlaceholder: "http://localhost:1234/v1",
    keyRequired: false,
  },
};

export const PROVIDER_LIST: ProviderMeta[] = Object.values(PROVIDERS);

export function familyOf(provider: ProviderType): ProviderFamily {
  return PROVIDERS[provider]?.family ?? "openai";
}
