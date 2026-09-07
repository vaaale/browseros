import "server-only";

// Per-CLI auth method (029-settings-dev-harness): each CLI's settings row
// presents ONE ordered choice unifying the credential-file paste option
// (harness-config.ts's writeClaudeCreds/writeOpenCodeAuth) with the provider
// options — "credential-file" means "use the pasted credential material,
// unchanged"; nothing else happens for that case.

export type ClaudeAuthMethod = "credential-file" | "api-key" | "oauth-token" | "bedrock" | "vertex";

export interface ClaudeProviderConfig {
  mode: ClaudeAuthMethod;
  apiKey?: string;
  // A long-lived token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) —
  // unlike credential-file, this is its own separate OAuth grant, not a copy
  // of an interactive session's rotating refresh token, so it never collides
  // with (and gets invalidated by) using `claude` locally.
  oauthToken?: string;
  baseUrl?: string;
  bedrockRegion?: string;
  bedrockProfile?: string;
  vertexProject?: string;
  vertexRegion?: string;
}

// OpenCode's auth method is a dropdown of real provider ids (029-settings-dev-harness
// US5) — a free-text id is unsafe: OpenCode only auto-configures providers from its
// built-in catalog (these 9 need nothing beyond apiKey/baseURL); anything else needs
// an npm adapter package + a models list to work at all (see "custom" below).
export const OPENCODE_GENERIC_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "groq",
  "deepseek",
  "together-ai",
  "fireworks-ai",
  "xai",
  "ollama",
] as const;
export type OpenCodeGenericProvider = (typeof OPENCODE_GENERIC_PROVIDERS)[number];

export type OpenCodeAuthMethod = "credential-file" | OpenCodeGenericProvider | "amazon-bedrock" | "google-vertex" | "azure" | "custom";

const OPENCODE_AUTH_METHODS: OpenCodeAuthMethod[] = [
  "credential-file",
  ...OPENCODE_GENERIC_PROVIDERS,
  "amazon-bedrock",
  "google-vertex",
  "azure",
  "custom",
];

export interface OpenCodeProviderConfig {
  mode: OpenCodeAuthMethod;
  // Generic providers + Azure + Custom.
  apiKey?: string;
  baseUrl?: string;
  // amazon-bedrock — file-based (opencode.json provider.options), no apiKey
  // (AWS-credential-based, not API-key-based).
  bedrockRegion?: string;
  bedrockProfile?: string;
  bedrockEndpoint?: string;
  // google-vertex — environment-variable-only per OpenCode's own docs (no
  // opencode.json options surface at all); see openCodeProviderEnv() below.
  vertexProject?: string;
  vertexLocation?: string;
  // azure — resource name is environment-variable-only; apiKey is file-based
  // (the two mechanisms aren't mutually exclusive per provider, just per field).
  azureResourceName?: string;
  // custom — the genuinely-arbitrary escape hatch; needs an npm adapter package
  // and at least one model id to actually function (OpenCode's own requirement
  // for ids outside its built-in catalog).
  customProviderId?: string;
  customNpmPackage?: string;
  customModelId?: string;
  // Context window size for the selected model, written into opencode.json as
  // provider.<id>.models.<modelId>.limit.context (context-size propagation
  // follow-up to 029-settings-dev-harness) — OpenCode has no visibility into
  // BOS's own model catalog, so this must be supplied explicitly to stop it
  // from exceeding the model's real context window.
  contextSize?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Reads the raw `dev-harness` namespace values into a typed Claude provider
 * config. Reads the current `claudeAuthMethod` field; if absent, falls back to
 * the pre-redesign `claudeProviderMode` field (whose `"default"` meant the same
 * thing as today's `"credential-file"`) so config saved before the 2026-07-27
 * UI rework still resolves correctly without a migration step.
 */
export function normalizeClaudeProvider(raw: Record<string, unknown>): ClaudeProviderConfig {
  const current = raw.claudeAuthMethod;
  const legacy = raw.claudeProviderMode;
  const mode: ClaudeAuthMethod =
    current === "api-key" || current === "oauth-token" || current === "bedrock" || current === "vertex" || current === "credential-file"
      ? current
      : legacy === "api-key" || legacy === "bedrock" || legacy === "vertex"
        ? legacy
        : "credential-file";
  return {
    mode,
    apiKey: str(raw.claudeApiKey),
    oauthToken: str(raw.claudeOAuthToken),
    baseUrl: str(raw.claudeApiBaseUrl),
    bedrockRegion: str(raw.claudeBedrockRegion),
    bedrockProfile: str(raw.claudeBedrockProfile),
    vertexProject: str(raw.claudeVertexProject),
    vertexRegion: str(raw.claudeVertexRegion),
  };
}

/**
 * Reads the raw `dev-harness` namespace values into a typed OpenCode provider
 * config. Reads `opencodeAuthMethod` if it's one of the current dropdown
 * values; otherwise falls back to the pre-redesign shape (`opencodeProviderMode:
 * "default"|"provider"` + a free-text `opencodeProviderId`). A legacy
 * `"provider"` value can't be reliably mapped to one of the 9 generic-fields
 * providers (the id might not even match one), so it maps to `"custom"` with
 * the original id preserved verbatim — never guessed into a specific catalog
 * entry, which could silently change behavior.
 */
export function normalizeOpenCodeProvider(raw: Record<string, unknown>): OpenCodeProviderConfig {
  const current = raw.opencodeAuthMethod;
  const legacyMode = raw.opencodeProviderMode;
  const mode: OpenCodeAuthMethod =
    typeof current === "string" && (OPENCODE_AUTH_METHODS as string[]).includes(current)
      ? (current as OpenCodeAuthMethod)
      : legacyMode === "provider"
        ? "custom"
        : "credential-file";

  const legacyProviderId = str(raw.opencodeProviderId);
  return {
    mode,
    apiKey: str(raw.opencodeApiKey),
    baseUrl: str(raw.opencodeBaseUrl),
    bedrockRegion: str(raw.opencodeBedrockRegion),
    bedrockProfile: str(raw.opencodeBedrockProfile),
    bedrockEndpoint: str(raw.opencodeBedrockEndpoint),
    vertexProject: str(raw.opencodeVertexProject),
    vertexLocation: str(raw.opencodeVertexLocation),
    azureResourceName: str(raw.opencodeAzureResourceName),
    customProviderId: str(raw.opencodeCustomProviderId) ?? (mode === "custom" ? legacyProviderId : undefined),
    customNpmPackage: str(raw.opencodeCustomNpmPackage),
    customModelId: str(raw.opencodeCustomModelId),
    contextSize: num(raw.opencodeContextSize),
  };
}

export function isNonDefaultClaudeProvider(cfg: ClaudeProviderConfig): boolean {
  return cfg.mode !== "credential-file";
}

export function isNonDefaultOpenCodeProvider(cfg: OpenCodeProviderConfig): boolean {
  return cfg.mode !== "credential-file";
}

// OpenCode: the provider id to prefix `model` with, e.g. "amazon-bedrock/<model>"
// or "<custom id>/<model>" — undefined when there's no provider selected at all
// (credential-file, or Custom with no id typed yet). Shared by generate-config.ts
// (writing opencode.json's `model` field) and harness-config.ts (the `--model` CLI
// flag) — both must agree on the qualified id, or OpenCode can't resolve a bare
// model id to the right provider and fails with a generic server error.
export function openCodeModelProviderId(cfg: OpenCodeProviderConfig): string | undefined {
  if (cfg.mode === "credential-file") return undefined;
  if (cfg.mode === "custom") return cfg.customProviderId;
  return cfg.mode; // amazon-bedrock / google-vertex / azure / one of the 9 generic ids — all literal ids
}

/**
 * Env vars OpenCode needs for auth methods with NO `opencode.json` config
 * surface (verified against OpenCode's own docs) — the caller (generate-config.ts)
 * resolves `vertexServiceAccountPath` (a file path, only when that credential has
 * actually been provisioned) and merges the result into the spawned `opencode`
 * process's environment (claude-runner.ts). Pure/no fs access, so it's easy to
 * reason about and test independently of where the service-account path comes from.
 */
export function openCodeProviderEnv(cfg: OpenCodeProviderConfig, vertexServiceAccountPath?: string): Record<string, string> {
  if (cfg.mode === "google-vertex") {
    return {
      ...(vertexServiceAccountPath ? { GOOGLE_APPLICATION_CREDENTIALS: vertexServiceAccountPath } : {}),
      ...(cfg.vertexProject ? { GOOGLE_CLOUD_PROJECT: cfg.vertexProject } : {}),
      ...(cfg.vertexLocation ? { VERTEX_LOCATION: cfg.vertexLocation } : {}),
    };
  }
  if (cfg.mode === "azure" && cfg.azureResourceName) {
    return { AZURE_RESOURCE_NAME: cfg.azureResourceName };
  }
  return {};
}

// ── Top-level harness selection (029-settings-dev-harness US4) ─────────────
// Which coding agent runs development tasks, and (Claude only) how it's
// invoked. Read-time-derived from the pre-redesign `transport` 5-way enum
// (`cli`/`opencode`/`stdio`/`http`/`sse`) when the new fields are absent.

export type HarnessSelection = "claude" | "opencode";
export type ClaudeRunMode = "cli" | "stdio" | "http" | "sse";

export interface HarnessFields {
  harness: HarnessSelection;
  claudeRunMode: ClaudeRunMode;
  claudeModel: string;
  opencodeModel: string;
}

const RUN_MODES: ClaudeRunMode[] = ["cli", "stdio", "http", "sse"];

export function resolveHarnessSelection(raw: Record<string, unknown>): HarnessFields {
  if (raw.harness === "claude" || raw.harness === "opencode") {
    return {
      harness: raw.harness,
      claudeRunMode: RUN_MODES.includes(raw.claudeRunMode as ClaudeRunMode) ? (raw.claudeRunMode as ClaudeRunMode) : "cli",
      claudeModel: str(raw.claudeModel) ?? "",
      opencodeModel: str(raw.opencodeModel) ?? "",
    };
  }

  // Legacy `transport` (pre-redesign 5-way enum) + shared `model` field.
  const legacyTransport = raw.transport;
  const legacyModel = str(raw.model) ?? "";
  if (legacyTransport === "opencode") {
    return { harness: "opencode", claudeRunMode: "cli", claudeModel: "", opencodeModel: legacyModel };
  }
  if (legacyTransport === "stdio" || legacyTransport === "http" || legacyTransport === "sse") {
    return { harness: "claude", claudeRunMode: legacyTransport, claudeModel: legacyModel, opencodeModel: "" };
  }
  return { harness: "claude", claudeRunMode: "cli", claudeModel: legacyModel, opencodeModel: "" };
}
