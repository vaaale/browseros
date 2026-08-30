import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { readNamespace } from "@/lib/config/store";
import { listMcpServers } from "@/lib/mcp/store";
import {
  claudeGeneratedSettingsPath,
  claudeGeneratedMcpConfigPath,
  openCodeGeneratedConfigPath,
  hasVertexServiceAccount,
  getVertexServiceAccountPath,
} from "./harness-config";
import {
  normalizeClaudeProvider,
  normalizeOpenCodeProvider,
  resolveHarnessSelection,
  openCodeProviderEnv,
  openCodeModelProviderId,
  type ClaudeProviderConfig,
  type OpenCodeProviderConfig,
} from "./provider";
import type { McpServerConfig } from "@/lib/mcp/types";

// Regenerates the Dev Harness's own native config files (029-settings-dev-harness)
// from the current provider selection + every MCP server flagged
// `includeInDevHarness` (014/030). These files are BOS-GENERATED — full
// replace, never merged, never hand-edited — so they are always overwritten
// in full here, including being deleted when there is nothing to put in them
// (which also keeps harness-config.ts's sync existence checks accurate).

async function writeGeneratedFile(file: string, data: Record<string, unknown>): Promise<void> {
  if (Object.keys(data).length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function transportOf(s: McpServerConfig): "http" | "sse" | "stdio" {
  return s.transport === "sse" ? "sse" : s.transport === "stdio" ? "stdio" : "http";
}

// http/sse: the bearer convenience token plus any custom headers (custom wins) —
// mirrors src/lib/mcp/client.ts's httpHeaders() merge precedence.
function mergedHeaders(s: McpServerConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = {
    ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
    ...(s.headers ?? {}),
  };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

// Claude Code's native `mcpServers` entry shape (~/.claude.json).
function toClaudeMcpEntry(s: McpServerConfig): Record<string, unknown> {
  if (transportOf(s) === "stdio") {
    return {
      command: s.command,
      ...(s.args?.length ? { args: s.args } : {}),
      ...(s.env ? { env: s.env } : {}),
    };
  }
  const headers = mergedHeaders(s);
  return {
    type: transportOf(s),
    url: s.endpoint,
    ...(headers ? { headers } : {}),
  };
}

// OpenCode's native `mcp` entry shape (opencode.json).
function toOpenCodeMcpEntry(s: McpServerConfig): Record<string, unknown> {
  if (transportOf(s) === "stdio") {
    return {
      type: "local",
      command: [s.command, ...(s.args ?? [])].filter((v): v is string => !!v),
      ...(s.env ? { environment: s.env } : {}),
      enabled: true,
    };
  }
  const headers = mergedHeaders(s);
  return {
    type: "remote",
    url: s.endpoint,
    ...(headers ? { headers } : {}),
    enabled: true,
  };
}

// Claude CLI: env vars per provider mode. "default" → {} (credential-file login
// untouched); the file itself is then deleted by writeGeneratedFile.
function claudeEnvBlock(cfg: ClaudeProviderConfig): Record<string, string> {
  if (cfg.mode === "api-key") {
    return {
      ...(cfg.apiKey ? { ANTHROPIC_API_KEY: cfg.apiKey } : {}),
      ...(cfg.baseUrl ? { ANTHROPIC_BASE_URL: cfg.baseUrl } : {}),
    };
  }
  if (cfg.mode === "oauth-token") {
    return cfg.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: cfg.oauthToken } : {};
  }
  if (cfg.mode === "bedrock") {
    return {
      CLAUDE_CODE_USE_BEDROCK: "1",
      ...(cfg.bedrockRegion ? { AWS_REGION: cfg.bedrockRegion } : {}),
      ...(cfg.bedrockProfile ? { AWS_PROFILE: cfg.bedrockProfile } : {}),
    };
  }
  if (cfg.mode === "vertex") {
    return {
      CLAUDE_CODE_USE_VERTEX: "1",
      ...(cfg.vertexProject ? { ANTHROPIC_VERTEX_PROJECT_ID: cfg.vertexProject } : {}),
      ...(cfg.vertexRegion ? { CLOUD_ML_REGION: cfg.vertexRegion } : {}),
    };
  }
  return {};
}

// OpenCode: the `provider.<id>` entry to write into opencode.json, if any.
// google-vertex returns undefined unconditionally — its required parameters are
// environment-variable-only (openCodeProviderEnv below), confirmed against
// OpenCode's own docs; there is no config.json options surface for it at all.
function openCodeProviderFileEntry(cfg: OpenCodeProviderConfig): Record<string, unknown> | undefined {
  if (cfg.mode === "credential-file" || cfg.mode === "google-vertex") return undefined;

  if (cfg.mode === "amazon-bedrock") {
    const options: Record<string, unknown> = {
      ...(cfg.bedrockRegion ? { region: cfg.bedrockRegion } : {}),
      ...(cfg.bedrockProfile ? { profile: cfg.bedrockProfile } : {}),
      ...(cfg.bedrockEndpoint ? { endpoint: cfg.bedrockEndpoint } : {}),
    };
    return Object.keys(options).length ? { options } : undefined;
  }

  if (cfg.mode === "azure") {
    // Resource name is env-var-only (openCodeProviderEnv); the API key IS file-based.
    return cfg.apiKey ? { options: { apiKey: cfg.apiKey } } : undefined;
  }

  if (cfg.mode === "custom") {
    if (!cfg.customProviderId) return undefined;
    const options: Record<string, unknown> = {
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    };
    return {
      npm: cfg.customNpmPackage || "@ai-sdk/openai-compatible",
      ...(Object.keys(options).length ? { options } : {}),
      models: { [cfg.customModelId || "default"]: {} },
    };
  }

  // One of the 9 generic-fields-only providers.
  const options: Record<string, unknown> = {
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
  };
  return Object.keys(options).length ? { options } : undefined;
}

export async function regenerateHarnessConfigFiles(): Promise<void> {
  const raw = await readNamespace("dev-harness");
  const claude = normalizeClaudeProvider(raw);
  const opencode = normalizeOpenCodeProvider(raw);
  const { opencodeModel: model } = resolveHarnessSelection(raw);
  const servers = (await listMcpServers()).filter((s) => s.includeInDevHarness === true);

  // Claude: provider env block.
  const env = claudeEnvBlock(claude);
  await writeGeneratedFile(claudeGeneratedSettingsPath(), Object.keys(env).length ? { env } : {});

  // Claude: mcpServers (NOT settings.json — Claude Code doesn't read MCP servers from there).
  const claudeMcpServers: Record<string, unknown> = {};
  for (const s of servers) claudeMcpServers[s.name] = toClaudeMcpEntry(s);
  await writeGeneratedFile(
    claudeGeneratedMcpConfigPath(),
    Object.keys(claudeMcpServers).length ? { mcpServers: claudeMcpServers } : {},
  );

  // OpenCode: provider/model + mcp, all in one file. Vertex/Azure's env-var-only
  // fields (project/location/resource name) never appear here — see
  // getOpenCodeProviderEnv(), injected at spawn time by claude-runner.ts instead.
  const ocConfig: Record<string, unknown> = {};
  const providerId = openCodeModelProviderId(opencode);
  if (providerId) {
    const entry = openCodeProviderFileEntry(opencode);
    if (entry) ocConfig.provider = { [providerId]: entry };
    if (model) ocConfig.model = `${providerId}/${model}`;
  }
  const ocMcp: Record<string, unknown> = {};
  for (const s of servers) ocMcp[s.name] = toOpenCodeMcpEntry(s);
  if (Object.keys(ocMcp).length) ocConfig.mcp = ocMcp;
  await writeGeneratedFile(openCodeGeneratedConfigPath(), ocConfig);
}

/**
 * Env vars to merge into the spawned `opencode` process's environment
 * (claude-runner.ts) for auth methods with no `opencode.json` config surface
 * (Vertex, Azure) — resolves the Vertex service-account file path (if
 * provisioned) and delegates to provider.ts's pure `openCodeProviderEnv`.
 */
export async function getOpenCodeProviderEnv(): Promise<Record<string, string>> {
  const raw = await readNamespace("dev-harness");
  const opencode = normalizeOpenCodeProvider(raw);
  const vertexPath = hasVertexServiceAccount() ? getVertexServiceAccountPath() : undefined;
  return openCodeProviderEnv(opencode, vertexPath);
}
