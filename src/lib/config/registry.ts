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

export interface ConfigRegistration {
  schema: ConfigSchema;
  load: () => Promise<Record<string, unknown>>;
  save: (patch: Record<string, unknown>) => Promise<void>;
}

const HARNESS_DEFAULT_URL = process.env.BOS_DEV_HARNESS_URL || "http://wingman.akhbar.lan:7272/mcp";
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
      fields: [],
    },
    load: async () => {
      const s = await readNamespace("build-studio");
      return { agent: (s.agent as string) || "build-studio" };
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
      };
    },
    save: async (patch) => {
      const next = { ...(await readNamespace("dev-harness")), ...patch };
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
      namespace: "self-modification",
      title: "Versions",
      description:
        "Live version control: preview, promote, and roll back BrowserOS versions via the Supervisor. Available when BrowserOS is served through `npm run supervisor`.",
      order: 36,
      customComponent: "self-modification",
      fields: [],
    },
    load: async () => ({}),
    save: async () => {},
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

/** Resolve the current tools.maxAgentSteps (used by start-run and inner-loop delegation).
 *  Always returns a clamped, defaulted number so callers never need to guard. */
export async function getMaxAgentSteps(): Promise<number> {
  const v = await getConfigValue("tools", "maxAgentSteps");
  const n = typeof v === "number" ? v : MAX_AGENT_STEPS_DEFAULT;
  return clampMaxAgentSteps(n);
}
