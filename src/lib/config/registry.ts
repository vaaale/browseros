import "server-only";
import type { ConfigField, ConfigSchema } from "./types";
import { readNamespace, patchNamespace, writeNamespace } from "./store";
import { listSettingsPanels } from "@/lib/bos-plugins/settings-registry";
import type { SettingsPanelRegistration } from "@/lib/bos-plugins/types";
import { getProviderConfig, updateProviderConfig, type ProviderConfig } from "@/lib/agent/provider";
import { PROVIDER_LIST } from "@/lib/agent/provider-meta";
import { getSettings, updateSettings } from "@/os/settings";
import { loadVoiceConfig, saveVoiceConfig, redactVoiceConfig } from "@/lib/voice/config";
import type { VoiceConfig } from "@/lib/voice/types";
import { regenerateHarnessConfigFiles } from "@/lib/devharness/generate-config";
import { normalizeClaudeProvider, normalizeOpenCodeProvider, resolveHarnessSelection } from "@/lib/devharness/provider";
import { flattenSelfHealConfig, readSelfHealConfig, patchSelfHealConfig } from "@/lib/self-heal/config";

export interface ConfigRegistration {
  schema: ConfigSchema;
  load: () => Promise<Record<string, unknown>>;
  save: (patch: Record<string, unknown>) => Promise<void>;
}

const HARNESS_DEFAULT_URL = process.env.BOS_DEV_HARNESS_URL || "http://localhost:7272/mcp";
const HARNESS_DEFAULT_COMMAND = "claude mcp serve";

// Clamps tools.maxFindResults into the spec-mandated 5..25 range (default 10).
// Shared by the load/save path AND the runtime resolver so a hand-edited config
// value can never break the discovery loop.
function clampMaxFindResults(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.max(5, Math.min(25, Math.round(n)));
}

// Clamps tools.toolCallTimeoutSec into 10..3600 seconds (default 600).
const TOOL_TIMEOUT_DEFAULT = 600;
function clampToolTimeout(n: number): number {
  if (!Number.isFinite(n)) return TOOL_TIMEOUT_DEFAULT;
  return Math.min(3600, Math.max(10, Math.round(n)));
}

// Clamps tools.maxAgentSteps into 4..200 (default 32).
const MAX_AGENT_STEPS_DEFAULT = 32;
function clampMaxAgentSteps(n: number): number {
  if (!Number.isFinite(n)) return MAX_AGENT_STEPS_DEFAULT;
  return Math.min(200, Math.max(4, Math.round(n)));
}

// Floors dev-harness.cliTimeoutSec at 60 seconds (default 1000), no upper bound.
// Headless Claude/OpenCode CLI runs can take a while; this is how long
// claude-runner.ts waits before killing the process and reporting a timeout.
export const CLI_TIMEOUT_SEC_DEFAULT = 1000;
export function clampCliTimeoutSec(n: number): number {
  if (!Number.isFinite(n)) return CLI_TIMEOUT_SEC_DEFAULT;
  return Math.max(60, Math.round(n));
}

const REGISTRATIONS: ConfigRegistration[] = [
  {
    schema: {
      namespace: "assistant",
      title: "Agents",
      description: "The assistant's agents and the shared default prompt they can inherit.",
      order: 5,
      customComponent: "agents",
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
      namespace: "voice",
      title: "Voice",
      description: "Text-to-speech and speech-to-text configuration for the assistant and Build Studio.",
      order: 11,
      customComponent: "voice",
      fields: [],
    },
    load: async () => redactVoiceConfig(await loadVoiceConfig()) as unknown as Record<string, unknown>,
    save: async (patch) => {
      await saveVoiceConfig(patch as Partial<VoiceConfig>);
    },
  },
  {
    schema: {
      namespace: "build-studio",
      title: "Build Studio",
      description: "Configuration for the Build Studio spec-authoring chat.",
      order: 12,
      customComponent: "build-studio",
      // `customComponent` means Settings renders BuildStudioTab instead of the
      // generic ConfigForm, so these declarations don't produce any UI. They
      // are still REQUIRED: /api/config's PATCH coerces the incoming values
      // against `fields` and silently drops anything undeclared — with an
      // empty array this namespace's Save wrote nothing at all, so neither the
      // BS chat agent nor the conflict agent could ever actually be changed.
      fields: [
        { key: "agent", label: "Agent", type: "text", description: "Sub-agent that powers the Build Studio chat." },
        {
          key: "conflictAgent",
          label: "Conflict resolution agent",
          type: "text",
          description: "Agent the git reconciliation pipeline escalates a merge conflict to (default: devops).",
        },
        {
          key: "defaultMethod",
          label: "Default spec method",
          type: "text",
          // FR-008a: `data/` is a per-user volume under Bastion, so this is
          // per-USER, not per-deployment. The wording says so because a
          // deployment-wide reading would imply one user's change moves
          // everyone's stores.
          description:
            "Method (spec framework) new stores use when they set none themselves — applies to your account only (default: spec-kit).",
        },
      ],
    },
    load: async () => {
      const s = await readNamespace("build-studio");
      return {
        agent: (s.agent as string) || "build-studio",
        // 035: which agent resolves git conflicts. Read on EVERY escalation
        // (reconcile.ts step 5), so a change takes effect with no reload.
        conflictAgent: (s.conflictAgent as string) || "devops",
        // 045 FR-008: the last link in the binding chain
        // (project.json -> spec-store.json -> here -> "spec-kit").
        defaultMethod: (s.defaultMethod as string) || "spec-kit",
      };
    },
    save: async (patch) => {
      await patchNamespace("build-studio", patch);
    },
  },
  {
    schema: {
      namespace: "tools",
      title: "Tools",
      description:
        "Global tool-description overrides. Rewrite what the LLM sees for any tool without editing source. Overrides apply to every agent (main-chat actions and sub-agent tools alike) and take effect on the next model turn.",
      order: 65,
      customComponent: "tools",
      fields: [
        {
          key: "maxFindResults",
          label: "Max discovery results",
          type: "number",
          description: "Max results returned by find_tools / find_agent. 5–25, default 10.",
        },
        {
          key: "toolCallTimeoutSec",
          label: "Tool call timeout (seconds)",
          type: "number",
          description:
            "Max time a single assistant tool call may run before it is aborted and reported to the agent as an error. Streaming tools (agent_delegate, workflow_run) treat this as an idle timeout instead. 10–3600, default 600.",
        },
        {
          key: "maxAgentSteps",
          label: "Max agent steps",
          type: "number",
          description:
            "Maximum number of model turns per agent run. Each agent (including delegated sub-agents) gets this many steps independently. 4–200, default 32.",
        },
      ],
    },
    load: async () => {
      const s = await readNamespace("tools");
      const raw = typeof s.maxFindResults === "number" ? s.maxFindResults : 10;
      const rawTimeout = typeof s.toolCallTimeoutSec === "number" ? s.toolCallTimeoutSec : TOOL_TIMEOUT_DEFAULT;
      const rawSteps = typeof s.maxAgentSteps === "number" ? s.maxAgentSteps : MAX_AGENT_STEPS_DEFAULT;
      return {
        maxFindResults: clampMaxFindResults(raw),
        toolCallTimeoutSec: clampToolTimeout(rawTimeout),
        maxAgentSteps: clampMaxAgentSteps(rawSteps),
      };
    },
    save: async (patch) => {
      const next: Record<string, unknown> = { ...patch };
      if (next.maxFindResults !== undefined) {
        const n = typeof next.maxFindResults === "number" ? next.maxFindResults : Number(next.maxFindResults);
        next.maxFindResults = clampMaxFindResults(Number.isFinite(n) ? n : 10);
      }
      if (next.toolCallTimeoutSec !== undefined) {
        const n = typeof next.toolCallTimeoutSec === "number" ? next.toolCallTimeoutSec : Number(next.toolCallTimeoutSec);
        next.toolCallTimeoutSec = clampToolTimeout(Number.isFinite(n) ? n : TOOL_TIMEOUT_DEFAULT);
      }
      if (next.maxAgentSteps !== undefined) {
        const n = typeof next.maxAgentSteps === "number" ? next.maxAgentSteps : Number(next.maxAgentSteps);
        next.maxAgentSteps = clampMaxAgentSteps(Number.isFinite(n) ? n : MAX_AGENT_STEPS_DEFAULT);
      }
      await patchNamespace("tools", next);
    },
  },
  {
    schema: {
      namespace: "mcp",
      title: "MCP Servers",
      description:
        "Connect Model Context Protocol servers so the assistant can use their tools. Supports Streamable HTTP and SSE (remote, with an optional bearer token or custom headers) and stdio (a local process, e.g. docker/npx, with env vars). Test a connection to list its tools.",
      order: 7,
      customComponent: "mcp",
      fields: [],
    },
    load: async () => ({}),
    save: async () => {},
  },
  {
    schema: {
      namespace: "apps",
      title: "Apps",
      description: "Manage installed apps. Uninstall keeps an app's files so it can be restored; purge deletes them.",
      order: 8,
      customComponent: "apps",
      fields: [],
    },
    load: async () => ({}),
    save: async () => {},
  },
  {
    schema: {
      namespace: "integrations",
      title: "Integrations",
      description:
        "Third-party accounts the assistant can act on. Upload your OAuth client credentials, connect, and toggle per-scope authorization. Phase 1 ships Gmail.",
      order: 9,
      customComponent: "integrations",
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
        { key: "maxTokens", label: "Max output tokens", type: "number", description: "Leave blank to use the provider's default." },
        { key: "maxInputTokens", label: "Context window", type: "number" },
        // Embeddings (028-memory-curation-retrieval, T3/FR-009). Declared here
        // as the config-registry redaction path (R8/S5) — distinct from the
        // provider-view's `hasEmbeddingKey` boolean; `secret: true` is what
        // makes config_list/config_set (and the generic /api/config GET/PATCH)
        // blank the key rather than leak it. The real Settings UI is the
        // custom "ai-provider" component (ProviderSettings.tsx), not the
        // generic field renderer, so these dotted keys need load()/save() below
        // to flatten/unflatten the nested `embeddings` object.
        { key: "embeddings.baseUrl", label: "Embedding base URL", type: "text", description: "Leave blank to use the LLM provider's base URL." },
        { key: "embeddings.apiKey", label: "Embedding API key", type: "password", secret: true, description: "Leave blank to use the LLM provider's API key." },
        { key: "embeddings.model", label: "Embedding model", type: "text", description: "Blank disables embeddings (search degrades to keyword + recency + importance)." },
      ],
    },
    load: async () => {
      const c = await getProviderConfig();
      return {
        ...c,
        "embeddings.baseUrl": c.embeddings?.baseUrl ?? "",
        "embeddings.apiKey": c.embeddings?.apiKey ?? "",
        "embeddings.model": c.embeddings?.model ?? "",
      };
    },
    save: async (patch) => {
      const flat = patch as Record<string, unknown>;
      const p: Partial<ProviderConfig> = { ...flat } as Partial<ProviderConfig>;
      const embeddings: Partial<ProviderConfig["embeddings"]> = {};
      let hasEmbeddingsPatch = false;
      for (const field of ["baseUrl", "apiKey", "model"] as const) {
        const dotted = `embeddings.${field}`;
        if (dotted in flat) {
          embeddings[field] = flat[dotted] as string;
          hasEmbeddingsPatch = true;
          delete (p as Record<string, unknown>)[dotted];
        }
      }
      if (hasEmbeddingsPatch) p.embeddings = embeddings;
      await updateProviderConfig(p);
    },
  },
  {
    schema: {
      namespace: "dev-harness",
      title: "Dev Harness",
      description:
        "How the developer sub-agent runs. 'Claude CLI' spawns Claude Code headless (`claude -p`) inside this repo so Claude itself edits BOS source — recommended. 'OpenCode CLI' spawns OpenCode headless (`opencode run`) instead — a provider-agnostic alternative. The MCP modes connect to a `claude mcp serve` (stdio) or a remote harness.",
      order: 30,
      customComponent: "dev-harness",
      fields: [
        // Top-level choice (029-settings-dev-harness US4): which coding agent
        // runs development tasks. Everything below is organized as one row per
        // CLI in the custom UI, ordered by real dependency (run mode → auth
        // method → that method's fields → model) — the `fields` array here
        // exists for the generic secret/coercion mechanism and the assistant's
        // auto-generated config tools, not for visual ordering.
        {
          key: "harness",
          label: "Dev Harness",
          type: "select",
          description: "Which coding agent runs development tasks.",
          options: [
            { value: "claude", label: "Claude Code" },
            { value: "opencode", label: "OpenCode" },
          ],
        },
        // Claude Code row.
        {
          key: "claudeRunMode",
          label: "Claude run mode",
          type: "select",
          description: "Local CLI spawns `claude` headless; the MCP modes instead drive an already-running remote Claude Code harness's Agent tool (no auth/model settings apply there).",
          options: [
            { value: "cli", label: "Local CLI (headless, recommended)" },
            { value: "stdio", label: "MCP stdio (claude mcp serve)" },
            { value: "http", label: "MCP HTTP (remote)" },
            { value: "sse", label: "MCP SSE (remote)" },
          ],
        },
        { key: "command", label: "MCP stdio command", type: "text", placeholder: HARNESS_DEFAULT_COMMAND },
        { key: "url", label: "MCP harness URL", type: "text", placeholder: HARNESS_DEFAULT_URL },
        {
          key: "claudeAuthMethod",
          label: "Claude auth method",
          type: "select",
          description: "How Claude CLI authenticates (Local run mode only).",
          options: [
            { value: "credential-file", label: "Credential file (paste below)" },
            { value: "api-key", label: "API key" },
            { value: "oauth-token", label: "OAuth token (claude setup-token)" },
            { value: "bedrock", label: "AWS Bedrock" },
            { value: "vertex", label: "Google Vertex AI" },
          ],
        },
        { key: "claudeApiKey", label: "Claude API key", type: "password", secret: true },
        { key: "claudeOAuthToken", label: "Claude OAuth token", type: "password", secret: true },
        { key: "claudeApiBaseUrl", label: "Claude API base URL", type: "text", placeholder: "https://api.anthropic.com" },
        { key: "claudeBedrockRegion", label: "Bedrock AWS region", type: "text", placeholder: "us-east-1" },
        { key: "claudeBedrockProfile", label: "Bedrock AWS profile", type: "text" },
        { key: "claudeVertexProject", label: "Vertex GCP project", type: "text" },
        { key: "claudeVertexRegion", label: "Vertex GCP region", type: "text", placeholder: "us-central1" },
        {
          key: "claudeModel",
          label: "Claude model override",
          type: "text",
          placeholder: "e.g. claude-opus-4-7 (blank = CLI default)",
          description: "Model id passed to Claude CLI via --model (Local run mode only). Leave blank to use the CLI's own default.",
        },
        // OpenCode row. The auth method IS the provider choice (029-settings-dev-harness
        // US5) — a free-text provider id was verified unsafe (see provider.ts), so this
        // is a dropdown of real ids; only some need fields beyond the generic pair below.
        {
          key: "opencodeAuthMethod",
          label: "OpenCode auth method",
          type: "select",
          description: "How OpenCode CLI authenticates.",
          options: [
            { value: "credential-file", label: "Credential file (paste below)" },
            { value: "anthropic", label: "Anthropic" },
            { value: "openai", label: "OpenAI" },
            { value: "openrouter", label: "OpenRouter" },
            { value: "groq", label: "Groq" },
            { value: "deepseek", label: "DeepSeek" },
            { value: "together-ai", label: "Together AI" },
            { value: "fireworks-ai", label: "Fireworks AI" },
            { value: "xai", label: "xAI" },
            { value: "ollama", label: "Ollama (local)" },
            { value: "amazon-bedrock", label: "AWS Bedrock" },
            { value: "google-vertex", label: "Google Vertex AI" },
            { value: "azure", label: "Azure OpenAI" },
            { value: "custom", label: "Custom" },
          ],
        },
        // Generic (Anthropic/OpenAI/OpenRouter/Groq/DeepSeek/Together AI/Fireworks AI/xAI/Ollama) + Azure + Custom.
        { key: "opencodeApiKey", label: "OpenCode API key", type: "password", secret: true },
        { key: "opencodeBaseUrl", label: "OpenCode base URL", type: "text" },
        // AWS Bedrock — no API key (AWS-credential-based).
        { key: "opencodeBedrockRegion", label: "Bedrock AWS region", type: "text", placeholder: "us-east-1" },
        { key: "opencodeBedrockProfile", label: "Bedrock AWS profile", type: "text" },
        { key: "opencodeBedrockEndpoint", label: "Bedrock VPC endpoint", type: "text" },
        // Google Vertex AI — environment-variable-only; see the credentials route for the service-account file.
        { key: "opencodeVertexProject", label: "Vertex GCP project", type: "text" },
        { key: "opencodeVertexLocation", label: "Vertex GCP location", type: "text", placeholder: "global" },
        // Azure OpenAI — resource name is environment-variable-only; API key (above) is file-based.
        { key: "opencodeAzureResourceName", label: "Azure resource name", type: "text" },
        // Custom — the genuinely-arbitrary escape hatch (needs an npm adapter + a model id to function).
        { key: "opencodeCustomProviderId", label: "Custom provider id", type: "text", placeholder: "e.g. myserver" },
        { key: "opencodeCustomNpmPackage", label: "Custom npm package", type: "text", placeholder: "@ai-sdk/openai-compatible" },
        { key: "opencodeCustomModelId", label: "Custom model id", type: "text" },
        {
          key: "opencodeModel",
          label: "OpenCode model override",
          type: "text",
          placeholder: "e.g. claude-opus-4-7 (blank = CLI default)",
          description: "Model id passed to OpenCode CLI via --model. Leave blank to use the CLI's own default.",
        },
        {
          key: "opencodeContextSize",
          label: "OpenCode context window",
          type: "number",
          description:
            "Context window (tokens) of the model above. Written into opencode.json as this model's limit.context, since OpenCode has no way to know BOS's own model catalog. Leave blank to use OpenCode's built-in default for this model (may not match BrowserOS's selected model and can overflow).",
        },
        // Shared by both CLI transports (Local run mode only — the MCP modes use
        // their own Agent-tool call timeout, unaffected by this).
        {
          key: "cliTimeoutSec",
          label: "CLI run timeout (seconds)",
          type: "number",
          description:
            "Max time a headless Claude/OpenCode CLI run may take before it's killed and reported as a timeout. Minimum 60s, default 1000, no upper bound.",
        },
      ],
    },
    load: async () => {
      const stored = await readNamespace("dev-harness");
      const { harness, claudeRunMode, claudeModel, opencodeModel } = resolveHarnessSelection(stored);
      const claude = normalizeClaudeProvider(stored);
      const opencode = normalizeOpenCodeProvider(stored);
      return {
        harness,
        claudeRunMode,
        command: (stored.command as string) || HARNESS_DEFAULT_COMMAND,
        url: (stored.url as string) || HARNESS_DEFAULT_URL,
        claudeAuthMethod: claude.mode,
        claudeApiKey: claude.apiKey || "",
        claudeOAuthToken: claude.oauthToken || "",
        claudeApiBaseUrl: claude.baseUrl || "",
        claudeBedrockRegion: claude.bedrockRegion || "",
        claudeBedrockProfile: claude.bedrockProfile || "",
        claudeVertexProject: claude.vertexProject || "",
        claudeVertexRegion: claude.vertexRegion || "",
        claudeModel,
        opencodeAuthMethod: opencode.mode,
        opencodeApiKey: opencode.apiKey || "",
        opencodeBaseUrl: opencode.baseUrl || "",
        opencodeBedrockRegion: opencode.bedrockRegion || "",
        opencodeBedrockProfile: opencode.bedrockProfile || "",
        opencodeBedrockEndpoint: opencode.bedrockEndpoint || "",
        opencodeVertexProject: opencode.vertexProject || "",
        opencodeVertexLocation: opencode.vertexLocation || "",
        opencodeAzureResourceName: opencode.azureResourceName || "",
        opencodeCustomProviderId: opencode.customProviderId || "",
        opencodeCustomNpmPackage: opencode.customNpmPackage || "",
        opencodeCustomModelId: opencode.customModelId || "",
        opencodeModel,
        opencodeContextSize: opencode.contextSize,
        cliTimeoutSec: clampCliTimeoutSec(typeof stored.cliTimeoutSec === "number" ? stored.cliTimeoutSec : CLI_TIMEOUT_SEC_DEFAULT),
      };
    },
    save: async (patch) => {
      const next: Record<string, unknown> = { ...(await readNamespace("dev-harness")), ...patch };
      if (next.cliTimeoutSec !== undefined) {
        const n = typeof next.cliTimeoutSec === "number" ? next.cliTimeoutSec : Number(next.cliTimeoutSec);
        next.cliTimeoutSec = clampCliTimeoutSec(Number.isFinite(n) ? n : CLI_TIMEOUT_SEC_DEFAULT);
      }
      delete next.cwd;
      // Only ever write the current field names going forward — the superseded
      // ones (transport/model/claudeProviderMode/opencodeProviderMode, and the
      // free-text opencodeProviderId superseded by opencodeAuthMethod's dropdown)
      // are read-time-derived by resolveHarnessSelection/normalize*Provider when
      // the current fields are absent, but a save should not perpetuate the old shape.
      delete next.transport;
      delete next.model;
      delete next.claudeProviderMode;
      delete next.opencodeProviderMode;
      delete next.opencodeProviderId;
      await writeNamespace("dev-harness", next);
      // Harness/provider/model may have changed — regenerate the harness's own
      // generated config files (029-settings-dev-harness).
      await regenerateHarnessConfigFiles();
    },
  },
  {
    schema: {
      namespace: "browser-automation",
      title: "Browser Automation",
      description:
        "Let the assistant drive a real browser (via the Playwright MCP server) to automate web tasks. Off by default and sandboxed: the browser is host-scoped (deny-by-default) and bypasses the in-app proxy's SSRF guard, so only origins you allow are reachable. Requires the @playwright/mcp package and an installed Chromium (`npx playwright install chromium`).",
      order: 40,
      fields: [
        { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch. When off, the assistant has no browser-automation tools." },
        { key: "allowedOrigins", label: "Allowed origins", type: "textarea", description: "Origins the browser may visit (comma/space/semicolon-separated). Empty = nothing is reachable." },
        { key: "blockedOrigins", label: "Blocked origins", type: "textarea", description: "Origins to always block." },
        { key: "headless", label: "Headless", type: "boolean" },
        { key: "isolated", label: "Isolated profile", type: "boolean", description: "Fresh in-memory profile (no access to saved cookies/sessions)." },
        { key: "downloads", label: "Allow downloads", type: "boolean" },
        {
          key: "consentPolicy",
          label: "Consent",
          type: "select",
          options: [
            { value: "off", label: "No prompt (within allowlist)" },
            { value: "per-session", label: "Ask once per session" },
            { value: "per-use", label: "Ask before each use" },
          ],
        },
        { key: "command", label: "MCP command", type: "text", placeholder: "npx @playwright/mcp" },
      ],
    },
    load: async () => {
      const s = await readNamespace("browser-automation");
      return {
        enabled: s.enabled === true,
        allowedOrigins: (s.allowedOrigins as string) ?? "",
        blockedOrigins: (s.blockedOrigins as string) ?? "",
        headless: s.headless !== false,
        isolated: s.isolated !== false,
        downloads: s.downloads === true,
        consentPolicy: (s.consentPolicy as string) || "per-use",
        command: (s.command as string) || "npx @playwright/mcp",
      };
    },
    save: async (patch) => {
      await patchNamespace("browser-automation", patch);
    },
  },
  {
    schema: {
      namespace: "datafs",
      title: "Data Isolation",
      description:
        "How a previewed BrowserOS version's data is isolated from your live data during live version control. The active version uses your real data dir; a previewed candidate gets a copy-on-write clone so testing can't pollute it. Only methods your filesystem supports are selectable.",
      order: 35,
      customComponent: "datafs",
      fields: [
        {
          key: "method",
          label: "Isolation method",
          type: "select",
          options: [
            { value: "auto", label: "Auto (recommended)" },
            { value: "reflink", label: "Reflink (copy-on-write)" },
            { value: "hardlink", label: "Hardlink farm" },
            { value: "copy", label: "Full copy" },
          ],
        },
      ],
    },
    load: async () => ({ method: ((await readNamespace("datafs")).method as string) || "auto" }),
    save: async (patch) => {
      await patchNamespace("datafs", patch);
    },
  },
  {
    schema: {
      // 050: the Supervisor's version controls, moved OFF the Repositories
      // page. They concern BrowserOS VERSIONS rather than repositories, and
      // keeping both on one page is what made the old one hard to read.
      // Relocated rather than removed — preview/promote/pin/discard is a real
      // capability with nowhere else to live.
      namespace: "supervisor-versions",
      title: "Versions",
      description:
        "Live version control: preview, promote, pin and roll back BrowserOS versions via the Supervisor. Available when BrowserOS is served through `npm run supervisor`.",
      order: 37,
      customComponent: "supervisor-versions",
      fields: [],
    },
    load: async () => ({}),
    save: async () => {},
  },
  {
    schema: {
      namespace: "self-modification",
      // 050 FR-010. The namespace stays `self-modification` — it is the key
      // this tab's committer identity is stored under, and renaming it would
      // orphan every existing setting to rename a heading.
      title: "Repositories",
      description:
        "Every git repository BrowserOS knows about — its kind, its branch, and whether it has work that is not saved or pushed. Add your own to build something that is not BrowserOS itself. Also carries live version control: preview, promote and roll back BrowserOS versions via the Supervisor.",
      order: 36,
      customComponent: "self-modification",
      fields: [
        {
          key: "gitName",
          label: "Committer name",
          type: "text",
          placeholder: "BrowserOS",
          description: "Name used for git commits BOS makes on your behalf (pulls, pushes, rebases, merges) across System Specs, User Specs, User Apps, and BOS Source. Blank falls back to \"BrowserOS\".",
        },
        {
          key: "gitEmail",
          label: "Committer email",
          type: "text",
          placeholder: "bos@localhost",
          description: "Email paired with the committer name above. Blank falls back to \"bos@localhost\".",
        },
      ],
    },
    load: async () => {
      const s = await readNamespace("self-modification");
      return {
        gitName: (s.gitName as string) || "",
        gitEmail: (s.gitEmail as string) || "",
      };
    },
    save: async (patch) => {
      await patchNamespace("self-modification", patch);
    },
  },
  {
    schema: {
      namespace: "selfHeal",
      title: "Self Improvement",
      description:
        "The self-healing mechanism (031-self-healing): BrowserOS notices its own failures, has a Diagnostician investigate them against its own source, and — for a genuine gap — drives a TDD'd fix onto a preview you review. Nothing is ever promoted automatically.",
      order: 34,
      customComponent: "self-improvement",
      // `customComponent` means Settings renders SelfImprovementTab instead of
      // the generic ConfigForm, so these declarations produce no UI. They are
      // still REQUIRED: /api/config's PATCH coerces incoming values against
      // `fields` and silently DROPS anything undeclared — an empty array here
      // would make every toggle in the tab a no-op on save (the same trap
      // documented on the `build-studio` registration above). They also expose
      // the namespace to the assistant's config_* tools.
      fields: [
        { key: "enabled", label: "Enable self-healing", type: "boolean", description: "Master switch. When off, no trigger fires, nothing is scheduled, and no tokens are spent." },
        { key: "triggers.explicit", label: "Trigger: explicit report", type: "boolean", description: "A person or agent calls self_heal_request, or uses \"Report a problem\" in Build Studio → Self-Heal." },
        { key: "triggers.hardError", label: "Trigger: hard error", type: "boolean", description: "One non-environmental tool error. Network/DNS/401/429/OOM/upstream-timeout failures are always filtered out." },
        { key: "triggers.repeatedFailure", label: "Trigger: repeated failure", type: "boolean", description: "N consecutive failures of the same tool with the same error signature inside the window below." },
        { key: "triggers.workflowTimeout", label: "Trigger: workflow timeout", type: "boolean", description: "A workflow run or long operation exceeds its configured timeout." },
        { key: "triggers.logEvents", label: "Trigger: log events", type: "boolean", description: "An error-level log event from a BrowserOS-owned component (third-party components never trigger)." },
        { key: "diagnostician.scheduled", label: "Run the Diagnostician on a schedule", type: "boolean", description: "Proactively review idle conversations for behavioral problems and diagnose any case still waiting." },
        { key: "diagnostician.idleThresholdSec", label: "Idle threshold (seconds)", type: "number", description: "How long a conversation must be untouched before the scheduled review considers it. Also the tick interval." },
        { key: "autonomousImplement", label: "Autonomous implement", type: "boolean", description: "Let a diagnosed core/app gap run the whole Build Studio pipeline unattended. Off = a diagnosed case waits for your go-ahead." },
        { key: "tdd.required", label: "TDD required", type: "boolean", description: "Instruct the developer to write the failing test first, then implement." },
        { key: "tdd.targetCoverage", label: "Coverage target (%)", type: "number", description: "Minimum line+branch coverage on the files a fix modifies." },
        { key: "costCapPerDay", label: "Cost cap (tokens/day)", type: "number", description: "Total self-heal token budget per UTC day. Over it, new triggers are QUEUED, never dropped. A case already running finishes." },
        { key: "dedupeWindowSec", label: "Dedupe window (seconds)", type: "number", description: "The same failure signature creates at most one case inside this window." },
        { key: "explicitDedupeWindowSec", label: "Dedupe window, explicit reports (seconds)", type: "number", description: "Shorter on purpose: re-reporting the same problem yourself is usually deliberate." },
        { key: "suspendedTimeoutDays", label: "Suspended timeout (days)", type: "number", description: "How long a fix waiting on your answer is held before it is abandoned and the pipeline slot freed." },
        { key: "costQueueMax", label: "Queue size limit", type: "number", description: "Maximum queued-over-budget cases. The oldest is evicted (and announced) beyond this." },
        { key: "costQueueTtlDays", label: "Queue TTL (days)", type: "number", description: "A case queued longer than this is evicted (and announced) regardless of position." },
        { key: "repeatedFailure.count", label: "Repeated failure: count", type: "number", description: "How many consecutive same-signature failures trip the repeated-failure trigger." },
        { key: "repeatedFailure.windowSec", label: "Repeated failure: window (seconds)", type: "number", description: "The rolling window those failures must fall inside." },
        { key: "hardError.minCount", label: "Hard error: minimum count", type: "number", description: "How many non-environmental failures inside the repeated-failure window the hard-error trigger needs before it opens a case. 1 fires on a single failure; below the count the failure is logged, never a case." },
        { key: "stuckDetector.enabled", label: "Detect stuck runs", type: "boolean", description: "Watch the Diagnostician and pipeline runs for a repeated tool call with no progress, or a run that exhausts its step budget, and flag the case. Deterministic — no extra model call. Stop/Start still work with this off." },
        { key: "stuckDetector.repeatCalls", label: "Stuck after N identical calls", type: "number", description: "How many times the same tool call (ignoring ids, timestamps and numbers) must repeat with nothing in between before the run is flagged stuck." },
      ],
    },
    load: async () => flattenSelfHealConfig(await readSelfHealConfig()),
    save: async (patch) => {
      await patchSelfHealConfig(patch);
    },
  },
  {
    schema: {
      namespace: "agentRuns",
      title: "Agent Runs",
      description:
        "Headless agent runs — the ones BrowserOS starts for itself (the scheduler, workflow steps, Telegram routing, delegation, and self-healing) rather than a chat you are watching. Each such run can leave a markdown transcript on disk so you can read back exactly what it did.",
      order: 35,
      fields: [
        {
          key: "transcriptions.enabled",
          label: "Record run transcripts",
          type: "boolean",
          description:
            "Write one markdown transcript per headless run to data/agent-transcripts/<agent>/<run>.md — the task, every tool call and result, and the final text. Off means no file is written and nothing is recorded (existing transcripts are kept). Live chat conversations are never transcribed here; they are already in Chats.",
        },
      ],
    },
    load: async () => {
      const s = await readNamespace("agentRuns");
      return { "transcriptions.enabled": s["transcriptions.enabled"] !== false };
    },
    save: async (patch) => {
      await patchNamespace("agentRuns", patch);
    },
  },
  {
    schema: {
      namespace: "system-tools",
      title: "System Tools",
      description:
        "Host-level command execution for the assistant. The legacy unsandboxed `bash -lc` tool has been removed; a sandboxed `run_command` (with Docker/local backends) replaces it. Leave disabled unless you trust the assistant to run commands in this environment.",
      order: 37,
      fields: [
        { key: "enabled", label: "Command execution enabled", type: "boolean", description: "Master switch for host-level command execution. Off by default." },
      ],
    },
    load: async () => {
      const s = await readNamespace("system-tools");
      return { enabled: s.enabled === true };
    },
    save: async (patch) => {
      await patchNamespace("system-tools", patch);
    },
  },
  {
    schema: {
      namespace: "run-command",
      title: "Command Execution",
      description:
        "Sandboxed command execution (run_command) for the assistant and sub-agents. The Docker backend runs each browser-session + agent in its own isolated container (non-root, network off by default), started on first use and kept alive for the session. The local backend runs directly on the host — only sensible when BOS itself runs inside a container (Bastion mode). Off by default.",
      order: 39,
      customComponent: "run-command",
      fields: [
        { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch for run_command. Off by default." },
        { key: "backend", label: "Backend", type: "select", options: [{ value: "docker", label: "Docker (isolated container)" }, { value: "local", label: "Local (host / Bastion)" }], description: "docker = isolated container per session+agent (recommended); local = run on the host (only if BOS is itself containerized)." },
        { key: "dockerImage", label: "Docker image", type: "text", description: "Image for the sandbox container. Default: browseros/run-command:latest." },
        { key: "network", label: "Container network", type: "boolean", description: "Allow the sandbox container network access. Off by default." },
        { key: "idleTimeoutSec", label: "Idle timeout (seconds)", type: "number", description: "Kill a command that produces no output for this long. Default 120." },
        { key: "maxTimeoutSec", label: "Max timeout (seconds)", type: "number", description: "Hard cap on a single command's total runtime. Default 600." },
      ],
    },
    load: async () => {
      const s = await readNamespace("run-command");
      return {
        enabled: s.enabled === true,
        backend: s.backend === "local" ? "local" : "docker",
        dockerImage: typeof s.dockerImage === "string" ? s.dockerImage : "",
        vfsMounts: Array.isArray(s.vfsMounts) ? s.vfsMounts : [],
        network: s.network === true,
        idleTimeoutSec: typeof s.idleTimeoutSec === "number" ? s.idleTimeoutSec : 120,
        maxTimeoutSec: typeof s.maxTimeoutSec === "number" ? s.maxTimeoutSec : 600,
      };
    },
    save: async (patch) => {
      await patchNamespace("run-command", patch);
    },
  },
  {
    schema: {
      namespace: "logging",
      title: "Logs",
      description:
        "Central logging: each browser session's frontend, backend, Supervisor, and conversation activity is collected into one time-ordered timeline (the Supervisor is the sink). View the whole system or one session and filter by stream/level/component/conversation. Build failures capture their full output.",
      order: 38,
      customComponent: "logging",
      fields: [
        {
          key: "level",
          label: "Minimum level",
          type: "select",
          options: [
            { value: "debug", label: "debug" },
            { value: "info", label: "info" },
            { value: "warn", label: "warn" },
            { value: "error", label: "error" },
          ],
        },
        { key: "retentionDays", label: "Retention (days)", type: "number" },
        { key: "maxSizeMb", label: "Max total size (MB)", type: "number" },
        { key: "frontendCapture", label: "Capture frontend logs", type: "boolean" },
        { key: "logPayload", label: "Log payload", type: "boolean" },
      ],
    },
    load: async () => {
      const s = await readNamespace("logging");
      return {
        level: (s.level as string) || "info",
        retentionDays: typeof s.retentionDays === "number" ? s.retentionDays : 7,
        maxSizeMb: typeof s.maxSizeMb === "number" ? s.maxSizeMb : 512,
        frontendCapture: s.frontendCapture !== false,
        logPayload: s.logPayload === true,
      };
    },
    save: async (patch) => {
      await patchNamespace("logging", patch);
    },
  },
  {
    schema: {
      namespace: "compaction",
      title: "Context Compaction",
      description:
        "Server-side view transformation on what is sent to the model as a conversation grows. Layer 1 clears old tool results, Layer 2 summarizes old turns in small blocks, Layer 3 truncates as a last resort.",
      order: 16,
      customComponent: "compaction",
      fields: [
        { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch. When off, the pipeline is a pass-through." },
        { key: "assumedContextTokens", label: "Assumed context window (tokens)", type: "number", description: "Used when the provider does not declare a context size. Default 128000." },
        { key: "clearThreshold", label: "Clear threshold", type: "number", description: "Fraction of the budget above which Layer 1 starts clearing old tool results. Default 0.50." },
        { key: "summarizeThreshold", label: "Summarize threshold", type: "number", description: "Fraction of the budget above which Layer 2 schedules block summarization. Default 0.75." },
        { key: "hardLimit", label: "Hard limit", type: "number", description: "Fraction of the budget above which Layer 3 truncates synchronously as a last resort. Default 0.92." },
        { key: "keepToolResults", label: "Keep last N tool-result pairs", type: "number", description: "Tool results older than the newest N pairs are eligible for Layer 1 clearing. Default 2." },
        { key: "keepTailTurns", label: "Keep tail turns", type: "number", description: "Minimum number of most-recent turns kept fully verbatim, never cleared/grouped. A floor — the token-based tail-budget fraction usually dominates in tool-heavy conversations. Default 3." },
        { key: "tailBudgetFraction", label: "Tail budget fraction", type: "number", description: "Target size of the kept tail as a fraction of the effective budget. Default 0.20." },
        { key: "unrecoverableTools", label: "Unrecoverable tools", type: "textarea", description: "Comma or newline separated tool names whose calls/results are never cleared or summarized away." },
        { key: "model", label: "Summarizer model override", type: "text", description: "Optional cheaper model id for block summarization." },
        { key: "lockStalenessMs", label: "Lock staleness (ms)", type: "number", description: "How long a stale block-formation lock is honored before being reclaimed. Default 600000 (10 min)." },
        { key: "blockSize", label: "Block size (turns)", type: "number", description: "How many turns get folded into one summary at a time. Smaller blocks summarize faster and more often; larger blocks make fewer, longer-lived summaries. Default 5." },
        { key: "maxRetainedBlocks", label: "Max retained blocks", type: "number", description: "How many block summaries are kept before the oldest is permanently discarded (no trace, no further degradation). Raising this keeps more distant history around at the cost of a larger prompt every turn. Default 8." },
      ],
    },
    load: async () => {
      const { readCompactionConfig } = await import("@/lib/agent/compaction/config");
      return (await readCompactionConfig()) as unknown as Record<string, unknown>;
    },
    save: async (patch) => {
      const { patchPluginConfig } = await import("@/lib/plugins/registry");
      const { _resetCompactionConfigCache } = await import("@/lib/agent/compaction/config");
      await patchPluginConfig("bos-compaction", patch);
      _resetCompactionConfigCache();
    },
  },
  {
    schema: {
      namespace: "plugins",
      title: "Plugins",
      description:
        "Manage server-side plugins that extend the assistant pipeline. Plugins can provide compaction, memory, telemetry, and other subsystems. Install from Marketplace, reorder the pipeline, and configure individual plugins.",
      order: 17,
      customComponent: "plugins",
      fields: [],
    },
    load: async () => ({}),
    save: async () => {},
  },
];

// Turn a camelCase / snake_case / kebab-case key into a human-readable label:
// "avatarServerUrl" → "Avatar Server URL", "default_avatar_id" → "Default
// Avatar Id". Used only as a fallback when the plugin's JSON schema doesn't
// declare an explicit `title` for the property.
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^(url|api|id|ttl|css|html|json|http|https|ws|uri|ip)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// Property shape we recognize inside a plugin's JSON schema. `title` is
// standard JSON Schema; `optionsEndpoint` is a BOS-specific extension used
// by ConfigForm to render a select whose options are fetched at render time.
type PluginPropertySchema = {
  type?: string;
  title?: string;
  description?: string;
  optionsEndpoint?: string;
};

// Build the ConfigField list for a plugin settings panel from its JSON-schema
// `configSchema.properties`. Shared by listConfigSchemas (schema view returned
// to Settings) and getRegistration's on-demand synthesis (so the API PATCH
// coerce step sees the same fields the UI was rendered from).
function buildPluginFields(panel: SettingsPanelRegistration): ConfigField[] {
  const properties = ((panel.configSchema as { properties?: Record<string, PluginPropertySchema> }).properties) ?? {};
  return Object.entries(properties).map(([key, def]) => {
    const baseType = def.type === "boolean" ? "boolean" : def.type === "number" ? "number" : "text";
    // A property with an optionsEndpoint is always rendered as a select —
    // its options are fetched at render time (see ConfigForm).
    const fieldType: ConfigField["type"] = def.optionsEndpoint ? "select" : baseType;
    return {
      key,
      label: def.title || humanizeKey(key),
      type: fieldType,
      description: def.description,
      secret: panel.secretFields.includes(key),
      optionsEndpoint: def.optionsEndpoint,
    };
  });
}

function pluginSchemaFor(panel: SettingsPanelRegistration): ConfigSchema {
  return {
    namespace: `plugin:${panel.pluginId}`,
    title: panel.label,
    icon: panel.icon,
    order: panel.order,
    fields: buildPluginFields(panel),
  } as ConfigSchema;
}

export function listConfigSchemas(): ConfigSchema[] {
  const pluginSchemas = listSettingsPanels().map(pluginSchemaFor);
  return [...REGISTRATIONS.map((r) => r.schema), ...pluginSchemas]
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function getRegistration(namespace: string): ConfigRegistration | undefined {
  const builtin = REGISTRATIONS.find((r) => r.schema.namespace === namespace);
  if (builtin) return builtin;
  // Plugin settings panels aren't in REGISTRATIONS — synthesize on demand so
  // the generic /api/config load/save path can reach them. Storage is the
  // usual data/config/<namespace>.json (namespace already carries the
  // "plugin:" prefix, matching the plugin SDK's readConfig/patchConfig).
  if (namespace.startsWith("plugin:")) {
    const panel = listSettingsPanels().find((p) => `plugin:${p.pluginId}` === namespace);
    if (!panel) return undefined;
    return {
      schema: pluginSchemaFor(panel),
      load: async () => readNamespace(namespace),
      save: async (patch) => {
        await patchNamespace(namespace, patch);
      },
    };
  }
  return undefined;
}

/** Helper for server features needing a resolved config value (with env defaults). */
export async function getConfigValue(namespace: string, key: string): Promise<unknown> {
  const reg = getRegistration(namespace);
  if (!reg) return undefined;
  return (await reg.load())[key];
}

/** Resolve the current tools.maxFindResults (used by find_tools / find_agent).
 *  Always returns a clamped, defaulted number so callers never need to guard. */
export async function getMaxFindResults(): Promise<number> {
  const v = await getConfigValue("tools", "maxFindResults");
  const n = typeof v === "number" ? v : 10;
  return clampMaxFindResults(n);
}

/** Is headless-run transcription on (031-self-healing FR-029/ADR-10)?
 *  Defaults to TRUE: a run BOS started for itself is only auditable if it left
 *  a transcript, so the observable default is "recorded". Read per call (never
 *  cached) so flipping the switch takes effect on the very next run. */
export async function transcriptEnabled(): Promise<boolean> {
  return (await getConfigValue("agentRuns", "transcriptions.enabled")) !== false;
}

/** Resolve the current tools.maxAgentSteps (used by start-run and inner-loop delegation).
 *  Always returns a clamped, defaulted number so callers never need to guard. */
export async function getMaxAgentSteps(): Promise<number> {
  const v = await getConfigValue("tools", "maxAgentSteps");
  const n = typeof v === "number" ? v : MAX_AGENT_STEPS_DEFAULT;
  return clampMaxAgentSteps(n);
}
