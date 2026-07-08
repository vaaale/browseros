import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { PROVIDERS, type ProviderType } from "./provider-meta";

const FILE = path.join(dataDir(), "provider.json");

export const DEFAULT_MAX_TOKENS = 65535;

export interface ProviderConfig {
  provider: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /** Max tokens the model may generate per response. Omit to let the provider use its own default. */
  maxTokens?: number;
  /** Context window (max input tokens) used for trimming. Optional. */
  maxInputTokens?: number;
}

export interface ProviderConfigView {
  provider: ProviderType;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  maxTokens?: number;
  maxInputTokens?: number;
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

/** Full config including the secret — server-only use (LLM clients, adapters). */
export async function getProviderConfig(): Promise<ProviderConfig> {
  const base = envConfig();
  try {
    const saved = JSON.parse(await fs.readFile(FILE, "utf8")) as Partial<ProviderConfig>;
    const provider = saved.provider ?? base.provider;
    return {
      provider,
      apiKey: saved.apiKey ?? base.apiKey,
      baseUrl: saved.baseUrl ?? base.baseUrl,
      model: saved.model || PROVIDERS[provider]?.defaultModel || base.model,
      maxTokens: "maxTokens" in saved
        ? (saved.maxTokens && saved.maxTokens > 0 ? saved.maxTokens : undefined)
        : base.maxTokens,
      maxInputTokens: saved.maxInputTokens ?? base.maxInputTokens,
    };
  } catch {
    return base;
  }
}

/** Safe view for the UI — never exposes the API key. */
export async function getProviderConfigView(): Promise<ProviderConfigView> {
  const c = await getProviderConfig();
  return {
    provider: c.provider,
    baseUrl: c.baseUrl ?? "",
    model: c.model,
    hasApiKey: !!c.apiKey,
    maxTokens: c.maxTokens,
    maxInputTokens: c.maxInputTokens,
  };
}

export async function updateProviderConfig(patch: Partial<ProviderConfig>): Promise<ProviderConfigView> {
  const current = await getProviderConfig();
  const provider = patch.provider ?? current.provider;
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
  };
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await writeFileAtomic(FILE, JSON.stringify(next, null, 2));
  return getProviderConfigView();
}

export async function hasCredentials(): Promise<boolean> {
  const c = await getProviderConfig();
  return !!c.apiKey || c.provider === "openai-compatible" || c.provider === "openai-responses";
}
