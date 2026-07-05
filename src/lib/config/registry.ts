import "server-only";
import type { ConfigSchema } from "./types";
import { readNamespace, patchNamespace, writeNamespace } from "./store";
import { getProviderConfig, updateProviderConfig, type ProviderConfig } from "@/lib/agent/provider";
import { PROVIDER_LIST } from "@/lib/agent/provider-meta";
import { getSettings, updateSettings } from "@/os/settings";

export interface ConfigRegistration {
  schema: ConfigSchema;
  load: () => Promise<Record<string, unknown>>;
  save: (patch: Record<string, unknown>) => Promise<void>;
}

const HARNESS_DEFAULT_URL = process.env.BOS_DEV_HARNESS_URL || "http://wingman.akhbar.lan:7272/mcp";
const HARNESS_DEFAULT_COMMAND = "claude mcp serve";

const REGISTRATIONS: ConfigRegistration[] = [
  {
    schema: {
      namespace: "assistant",
      title: "Assistant",
      description: "The assistant's agents and which one is the active personality.",
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
        {
          key: "transport",
          label: "Mode",
          type: "select",
          description: "Claude/OpenCode CLI run a coding agent headless in the repo; the MCP modes drive a harness's Agent tool.",
          options: [
            { value: "cli", label: "Claude CLI (headless, recommended)" },
            { value: "opencode", label: "OpenCode CLI (headless)" },
            { value: "stdio", label: "MCP stdio (claude mcp serve)" },
            { value: "http", label: "MCP HTTP (remote)" },
            { value: "sse", label: "MCP SSE (remote)" },
          ],
        },
        { key: "command", label: "MCP stdio command", type: "text", placeholder: HARNESS_DEFAULT_COMMAND },
        { key: "url", label: "MCP harness URL", type: "text", placeholder: HARNESS_DEFAULT_URL },
      ],
    },
    load: async () => {
      const stored = await readNamespace("dev-harness");
      return {
        transport: (stored.transport as string) || "cli",
        command: (stored.command as string) || HARNESS_DEFAULT_COMMAND,
        url: (stored.url as string) || HARNESS_DEFAULT_URL,
      };
    },
    save: async (patch) => {
      const next = { ...(await readNamespace("dev-harness")), ...patch };
      delete next.cwd;
      await writeNamespace("dev-harness", next);
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
        "Sandboxed command execution (run_command) for the assistant and sub-agents. The Docker backend runs each browser-session + agent in its own isolated container (non-root, network off by default), started on first use and kept alive for the session; /workspace is a folder in your virtual file system, so files the assistant writes and command outputs show up in the Files app. The local backend runs directly on the host — only sensible when BOS itself runs inside a container. Off by default.",
      order: 39,
      fields: [
        { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch for run_command. Off by default." },
        { key: "backend", label: "Backend", type: "select", options: [{ value: "docker", label: "Docker (isolated container)" }, { value: "local", label: "Local (host)" }], description: "docker = isolated container per session+agent (recommended); local = run on the host (only if BOS is itself containerized)." },
        { key: "dockerImage", label: "Docker image", type: "text", description: "Image for the sandbox container. Must include the runtimes your skills need (python, node, LibreOffice, …). Default: browseros/run-command:latest (build: docker build -t browseros/run-command:latest docker/run-command)." },
        { key: "workspace", label: "Workspace (VFS path)", type: "text", description: "Virtual file system folder mounted read-write as /workspace. Files the assistant writes here and command outputs appear in the Files app. Default: /workspace." },
        { key: "volumes", label: "Extra bind mounts", type: "textarea", description: "One per line: /host/path:ro or /host/path:rw (mounted at the same path in the container). Never mount secrets or BOS source rw." },
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
        workspace: typeof s.workspace === "string" ? s.workspace : "",
        volumes: typeof s.volumes === "string" ? s.volumes : "",
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
