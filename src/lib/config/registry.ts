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
      ],
    },
    load: async () => {
      const s = await readNamespace("tools");
      const raw = typeof s.maxFindResults === "number" ? s.maxFindResults : 10;
      const rawTimeout = typeof s.toolCallTimeoutSec === "number" ? s.toolCallTimeoutSec : TOOL_TIMEOUT_DEFAULT;
      return {
        maxFindResults: clampMaxFindResults(raw),
        toolCallTimeoutSec: clampToolTimeout(rawTimeout),
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
      namespace: "memoryLoops",
      title: "Memory Loops",
      description:
        "Automated memory reflection. The fast loop reviews idle conversations every few minutes and writes episodes; the slow loop consolidates pending episodes into topic-sharded long-term memory hourly. Both are system-category scheduler jobs and produce zero LLM cost when idle.",
      order: 15,
      fields: [
        { key: "fastLoop.enabled", label: "Fast loop enabled", type: "boolean", description: "Automatically review idle conversations and write episodes." },
        { key: "fastLoop.tickIntervalSec", label: "Fast loop tick (seconds)", type: "number", description: "How often the fast loop wakes up. Default 120." },
        { key: "fastLoop.idleThresholdSec", label: "Idle threshold (seconds)", type: "number", description: "A conversation must be idle this long before it's eligible for review. Default 300." },
        { key: "fastLoop.turnCap", label: "Unreviewed turn cap", type: "number", description: "Force a review when this many new turns pile up, even without idle. Default 40." },
        { key: "fastLoop.minNewTurns", label: "Minimum new turns", type: "number", description: "Skip conversations with fewer new assistant turns than this (trivial-exchange debounce). Default 4." },
        { key: "slowLoop.enabled", label: "Slow loop enabled", type: "boolean", description: "Consolidate pending episodes into long-term memory topics and skills." },
        { key: "slowLoop.intervalSec", label: "Slow loop interval (seconds)", type: "number", description: "How often the slow loop runs. Default 3600 (hourly)." },
        { key: "slowLoop.batchSize", label: "Slow loop batch size", type: "number", description: "Max pending episodes processed per run. Default 10." },
        { key: "modelOverride", label: "Model override", type: "text", description: "Optional model id to override the default provider for both loops. Leave blank to use the provider default." },
        { key: "episodeArchiveAgeDays", label: "Archive age (days)", type: "number", description: "Consolidated episodes older than this move to .Archive/ (never deleted). Default 14." },
        { key: "topicBudget", label: "Topic budget (chars)", type: "number", description: "Per-topic character budget before a new shard is created. Default 4000." },
      ],
    },
    load: async () => {
      const s = await readNamespace("memoryLoops");
      return {
        "fastLoop.enabled": s["fastLoop.enabled"] !== false,
        "fastLoop.tickIntervalSec": typeof s["fastLoop.tickIntervalSec"] === "number" ? s["fastLoop.tickIntervalSec"] : 120,
        "fastLoop.idleThresholdSec": typeof s["fastLoop.idleThresholdSec"] === "number" ? s["fastLoop.idleThresholdSec"] : 300,
        "fastLoop.turnCap": typeof s["fastLoop.turnCap"] === "number" ? s["fastLoop.turnCap"] : 40,
        "fastLoop.minNewTurns": typeof s["fastLoop.minNewTurns"] === "number" ? s["fastLoop.minNewTurns"] : 4,
        "slowLoop.enabled": s["slowLoop.enabled"] !== false,
        "slowLoop.intervalSec": typeof s["slowLoop.intervalSec"] === "number" ? s["slowLoop.intervalSec"] : 3600,
        "slowLoop.batchSize": typeof s["slowLoop.batchSize"] === "number" ? s["slowLoop.batchSize"] : 10,
        modelOverride: typeof s.modelOverride === "string" ? s.modelOverride : "",
        episodeArchiveAgeDays: typeof s.episodeArchiveAgeDays === "number" ? s.episodeArchiveAgeDays : 14,
        topicBudget: typeof s.topicBudget === "number" ? s.topicBudget : 4000,
      };
    },
    save: async (patch) => {
      await patchNamespace("memoryLoops", patch);
    },
  },
  {
    schema: {
      namespace: "compaction",
      title: "Context Compaction",
      description:
        "Server-side view transformation on what is sent to the model. Layer 1 clears older tool results in stable batches once estimated tokens cross clearThreshold. Layer 2 asynchronously summarizes past summarizeThreshold. Layer 3 (hard-limit) truncates pair-safely as a last resort so the provider never sees a context-length overflow. The client-owned transcript at /Documents/Chats is never rewritten.",
      order: 16,
      fields: [
        { key: "enabled", label: "Enabled", type: "boolean", description: "Master switch. When off, the middleware is a pass-through and every request goes to the provider verbatim." },
        { key: "assumedContextTokens", label: "Assumed context window (tokens)", type: "number", description: "Used when the provider does not declare a maxInputTokens. Default 128000." },
        { key: "clearThreshold", label: "Clear threshold (fraction of budget)", type: "number", description: "Estimated tokens above this fraction trigger Layer 1 tool-result clearing. Default 0.50." },
        { key: "summarizeThreshold", label: "Summarize threshold (fraction of budget)", type: "number", description: "Estimated tokens above this fraction schedule Layer 2 (async summarization). Default 0.75." },
        { key: "hardLimit", label: "Hard limit (fraction of budget)", type: "number", description: "Estimated tokens above this fraction trigger the synchronous pair-safe truncation fallback. Default 0.92." },
        { key: "keepToolResults", label: "Keep last N tool-result pairs", type: "number", description: "Tool-results at positions older than the newest N pairs are eligible for clearing. Default 5." },
        { key: "keepTailMessages", label: "Minimum tail messages", type: "number", description: "The kept tail is at least this many messages, even if they exceed the tail-budget fraction. Default 10." },
        { key: "tailBudgetFraction", label: "Tail-budget fraction", type: "number", description: "Target size of the kept tail expressed as a fraction of the effective budget. Default 0.20." },
        { key: "unrecoverableTools", label: "Unrecoverable tools", type: "textarea", description: "Comma or newline separated list of tool names whose results must never be cleared." },
        { key: "model", label: "Summarizer model override", type: "text", description: "Optional cheaper model id for the summarizer. Leave blank to use the current provider default." },
        { key: "lockStalenessMs", label: "Lock staleness (ms)", type: "number", description: "How long a summarization lock is honored before another turn is allowed to reclaim it. Default 600000 (10 min)." },
      ],
    },
    load: async () => {
      const s = await readNamespace("compaction");
      return {
        enabled: s.enabled !== false,
        assumedContextTokens: typeof s.assumedContextTokens === "number" ? s.assumedContextTokens : 128_000,
        clearThreshold: typeof s.clearThreshold === "number" ? s.clearThreshold : 0.5,
        summarizeThreshold: typeof s.summarizeThreshold === "number" ? s.summarizeThreshold : 0.75,
        hardLimit: typeof s.hardLimit === "number" ? s.hardLimit : 0.92,
        keepToolResults: typeof s.keepToolResults === "number" ? s.keepToolResults : 5,
        keepTailMessages: typeof s.keepTailMessages === "number" ? s.keepTailMessages : 10,
        tailBudgetFraction: typeof s.tailBudgetFraction === "number" ? s.tailBudgetFraction : 0.2,
        unrecoverableTools: Array.isArray(s.unrecoverableTools)
          ? (s.unrecoverableTools as unknown[]).filter((v): v is string => typeof v === "string").join(", ")
          : typeof s.unrecoverableTools === "string" ? s.unrecoverableTools : "",
        model: typeof s.model === "string" ? s.model : "",
        lockStalenessMs: typeof s.lockStalenessMs === "number" ? s.lockStalenessMs : 600_000,
      };
    },
    save: async (patch) => {
      const next: Record<string, unknown> = { ...patch };
      if (typeof next.unrecoverableTools === "string") {
        next.unrecoverableTools = (next.unrecoverableTools as string)
          .split(/[,\s;]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      await patchNamespace("compaction", next);
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

/** Resolve the current tools.maxFindResults (used by find_tools / find_agent).
 *  Always returns a clamped, defaulted number so callers never need to guard. */
export async function getMaxFindResults(): Promise<number> {
  const v = await getConfigValue("tools", "maxFindResults");
  const n = typeof v === "number" ? v : 10;
  return clampMaxFindResults(n);
}
