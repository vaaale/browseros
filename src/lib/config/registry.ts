import "server-only";
import type { ConfigSchema } from "./types";
import { readNamespace, patchNamespace } from "./store";
import { getProviderConfig, updateProviderConfig, type ProviderConfig } from "@/lib/agent/provider";
import { PROVIDER_LIST } from "@/lib/agent/provider-meta";
import { getSettings, updateSettings } from "@/os/settings";

export interface ConfigRegistration {
  schema: ConfigSchema;
  load: () => Promise<Record<string, unknown>>;
  save: (patch: Record<string, unknown>) => Promise<void>;
}

const HARNESS_DEFAULT_URL = process.env.BOS_DEV_HARNESS_URL || "http://wingman.akhbar.home:7272/mcp";

const REGISTRATIONS: ConfigRegistration[] = [
  {
    schema: {
      namespace: "assistant",
      title: "Assistant",
      description: "Personality profiles for the BOS assistant.",
      order: 5,
      customComponent: "assistant",
      fields: [],
    },
    load: async () => ({}),
    save: async () => {},
  },
  {
    schema: {
      namespace: "skills",
      title: "Skills",
      description: "The assistant's reusable skill library.",
      order: 6,
      customComponent: "skills",
      fields: [],
    },
    load: async () => ({}),
    save: async () => {},
  },
  {
    schema: {
      namespace: "appearance",
      title: "Appearance",
      description: "Wallpaper and accent color.",
      order: 10,
      customComponent: "appearance",
      fields: [
        { key: "wallpaper", label: "Wallpaper", type: "text", description: "Preset id, URL, or VFS path" },
        {
          key: "wallpaperFit",
          label: "Fit",
          type: "select",
          options: [
            { value: "cover", label: "cover" },
            { value: "contain", label: "contain" },
          ],
        },
        { key: "accent", label: "Accent color", type: "text", placeholder: "#5b8cff" },
      ],
    },
    load: async () => ({ ...(await getSettings()) }),
    save: async (patch) => {
      await updateSettings(patch);
    },
  },
  {
    schema: {
      namespace: "ai-provider",
      title: "AI Provider",
      description: "Model provider, key, base URL, and token limits.",
      order: 20,
      customComponent: "ai-provider",
      fields: [
        { key: "provider", label: "Provider", type: "select", options: PROVIDER_LIST.map((p) => ({ value: p.id, label: p.label })) },
        { key: "model", label: "Model", type: "text" },
        { key: "baseUrl", label: "Base URL", type: "text" },
        { key: "apiKey", label: "API key", type: "password", secret: true },
        { key: "maxTokens", label: "Max output tokens", type: "number" },
        { key: "maxInputTokens", label: "Context window", type: "number" },
      ],
    },
    load: async () => ({ ...(await getProviderConfig()) }),
    save: async (patch) => {
      await updateProviderConfig(patch as Partial<ProviderConfig>);
    },
  },
  {
    schema: {
      namespace: "dev-harness",
      title: "Dev Harness",
      description: "Claude Code MCP server used by the dev studio and Claude sub-agents. The agent type is generated per sub-agent (from its name), not configured here.",
      order: 30,
      fields: [{ key: "url", label: "Harness URL", type: "text", placeholder: HARNESS_DEFAULT_URL }],
    },
    load: async () => {
      const stored = await readNamespace("dev-harness");
      return { url: (stored.url as string) || HARNESS_DEFAULT_URL };
    },
    save: async (patch) => {
      await patchNamespace("dev-harness", patch);
    },
  },
];

export function listConfigSchemas(): ConfigSchema[] {
  return [...REGISTRATIONS].sort((a, b) => (a.schema.order ?? 100) - (b.schema.order ?? 100)).map((r) => r.schema);
}

export function getRegistration(namespace: string): ConfigRegistration | undefined {
  return REGISTRATIONS.find((r) => r.schema.namespace === namespace);
}

/** Helper for server features needing a resolved config value (with env defaults). */
export async function getConfigValue(namespace: string, key: string): Promise<unknown> {
  const reg = getRegistration(namespace);
  if (!reg) return undefined;
  return (await reg.load())[key];
}
