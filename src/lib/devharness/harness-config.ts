import "server-only";
import fs from "fs";
import path from "path";
import { getRegistration } from "@/lib/config/registry";
import { dataDir } from "@/os/data-dir";
import { getSourceRepoRoot } from "@/lib/gitops/filesystems";
import { resolveHarnessSelection, normalizeOpenCodeProvider, openCodeModelProviderId } from "./provider";
import type { McpServerConfig } from "@/lib/mcp/types";

// ── Harness credential storage (010/026) ────────────────────────────────────
// Claude Code and OpenCode read their auth from files under $HOME. In a
// container there is no interactive login and no ambient ~/.claude, so we let
// the user paste the credential material and materialise it into a dedicated
// harness HOME that we point the CLIs at via the HOME env var when spawning.
//
// The files are the single source of truth; they are written with owner-only
// permissions (dir 0700, files 0600). The raw content is never stored in the
// config namespace nor returned to the client — only a set/unset indicator.

function harnessHome(): string {
  return path.join(dataDir(), "dev-harness", "home");
}

export function getHarnessHome(): string {
  return harnessHome();
}

function claudeCredsPath(): string {
  return path.join(harnessHome(), ".claude", ".credentials.json");
}

function openCodeAuthPath(): string {
  return path.join(harnessHome(), ".local", "share", "opencode", "auth.json");
}

// A third credential file (029-settings-dev-harness US5): OpenCode's
// "Google Vertex AI" auth method needs a GCP service-account JSON, which
// OpenCode reads via GOOGLE_APPLICATION_CREDENTIALS (a file path — Vertex has
// no config.json options surface at all, per OpenCode's own docs), so BOS
// needs an actual file on disk to point that env var at, same as the other two.
function vertexServiceAccountPath(): string {
  return path.join(harnessHome(), ".config", "gcloud", "opencode-vertex-sa.json");
}

export function getVertexServiceAccountPath(): string {
  return vertexServiceAccountPath();
}

export function hasClaudeCreds(): boolean {
  return fs.existsSync(claudeCredsPath());
}

export function hasOpenCodeAuth(): boolean {
  return fs.existsSync(openCodeAuthPath());
}

export function hasVertexServiceAccount(): boolean {
  return fs.existsSync(vertexServiceAccountPath());
}

// ── Generated harness config files (029-settings-dev-harness) ──────────────
// Distinct from the credential files above: these are BOS-GENERATED (never
// hand-edited) from the Dev Harness's provider selection and any MCP servers
// flagged `includeInDevHarness`. generate-config.ts writes them; it only
// imports path helpers FROM this file (never the reverse) to avoid a circular
// import between the two modules.

/** Claude CLI: provider `env` block. NOT the same file as MCP config below —
 *  Claude Code does not read `mcpServers` from settings.json. */
export function claudeGeneratedSettingsPath(): string {
  return path.join(harnessHome(), ".claude", "settings.json");
}

/** Claude CLI: user-scope `mcpServers`, folded in from `includeInDevHarness` servers. */
export function claudeGeneratedMcpConfigPath(): string {
  return path.join(harnessHome(), ".claude.json");
}

/** OpenCode CLI: `provider`/`model`/`mcp` fields, all in the one config file. */
export function openCodeGeneratedConfigPath(): string {
  return path.join(harnessHome(), ".config", "opencode", "opencode.json");
}

function hasGeneratedHarnessConfig(): boolean {
  return (
    fs.existsSync(claudeGeneratedSettingsPath()) ||
    fs.existsSync(claudeGeneratedMcpConfigPath()) ||
    fs.existsSync(openCodeGeneratedConfigPath())
  );
}

function writeSecretFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

export function writeClaudeCreds(content: string): void {
  writeSecretFile(claudeCredsPath(), content);
}

export function writeOpenCodeAuth(content: string): void {
  writeSecretFile(openCodeAuthPath(), content);
}

export function writeVertexServiceAccount(content: string): void {
  writeSecretFile(vertexServiceAccountPath(), content);
}

export function clearClaudeCreds(): void {
  fs.rmSync(claudeCredsPath(), { force: true });
}

export function clearOpenCodeAuth(): void {
  fs.rmSync(openCodeAuthPath(), { force: true });
}

export function clearVertexServiceAccount(): void {
  fs.rmSync(vertexServiceAccountPath(), { force: true });
}

/**
 * Environment overrides for spawning the headless CLIs. Points HOME at the
 * harness home whenever there is ANY dev-harness customization to honor —
 * raw pasted credentials, a non-default provider, or at least one
 * `includeInDevHarness` MCP server (both materialized as generated config
 * files by generate-config.ts) — so local dev with a real ~/.claude and no
 * BOS-side customization at all keeps working unaffected (029-settings-dev-harness).
 */
export function harnessCredentialEnv(): Record<string, string> {
  if (!hasClaudeCreds() && !hasOpenCodeAuth() && !hasGeneratedHarnessConfig()) return {};
  const home = harnessHome();
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
}

// How the developer sub-agent is run (Settings → Dev Harness):
//  - "cli" (tool "claude"): spawn Claude Code headless (`claude -p`) in the repo.
//    Claude itself is the autonomous coding agent. Default.
//  - "cli" (tool "opencode"): spawn OpenCode headless (`opencode run`) in the repo.
//    OpenCode is the autonomous coding agent — a provider-agnostic alternative.
//  - "mcp": connect to a Claude Code MCP harness (stdio `claude mcp serve` or a
//    remote HTTP/SSE server) and drive its Agent tool. Kept for remote setups.
// Both CLI tools spawn a headless agent; source edits are later re-pointed to the
// Supervisor preview worktree by `claude-runner.ts`. The configured namespace does
// not expose a cwd knob because users must not choose where BOS source edits land.
export type HarnessConfig =
  | { mode: "cli"; tool: "claude" | "opencode"; cwd: string; model?: string; timeoutMs: number }
  | { mode: "mcp"; server: McpServerConfig };

// Fallback only for the defensive `reg` missing case below (the "dev-harness"
// namespace is always registered in registry.ts, so this never actually fires).
// The real default/clamp lives in registry.ts's clampCliTimeoutSec, applied at
// load() time — by the time it reaches here, v.cliTimeoutSec is already valid.
const CLI_TIMEOUT_SEC_FALLBACK = 1000;

export async function getHarnessConfig(): Promise<HarnessConfig> {
  const reg = getRegistration("dev-harness");
  const v = (reg ? await reg.load() : {}) as Record<string, unknown>;
  const { harness, claudeRunMode, claudeModel, opencodeModel } = resolveHarnessSelection(v);
  // NOT a bare process.cwd() — under the Supervisor, the process serving this
  // request may be running from a detached, linked preview worktree rather
  // than the main repo (see filesystems.ts's getSourceRepoRoot doc comment).
  // A stale/removed worktree there previously surfaced as CLI probes failing
  // with "the current working directory was deleted".
  const cwd = await getSourceRepoRoot();
  const timeoutMs = (typeof v.cliTimeoutSec === "number" ? v.cliTimeoutSec : CLI_TIMEOUT_SEC_FALLBACK) * 1000;

  if (harness === "opencode") {
    // The `--model` CLI flag must be provider-qualified ("<providerId>/<model>"),
    // same as opencode.json's own `model` field (generate-config.ts) — a bare
    // model id (e.g. "Qwen3.8-27B") can't be resolved to a provider by OpenCode
    // and fails at request time with a generic "Unexpected server error".
    const providerId = openCodeModelProviderId(normalizeOpenCodeProvider(v));
    const model = opencodeModel && providerId ? `${providerId}/${opencodeModel}` : opencodeModel || undefined;
    return { mode: "cli", tool: "opencode", cwd, model, timeoutMs };
  }
  // harness === "claude"
  if (claudeRunMode === "cli") return { mode: "cli", tool: "claude", cwd, model: claudeModel || undefined, timeoutMs };
  if (claudeRunMode === "stdio") {
    return {
      mode: "mcp",
      server: { name: "dev-harness", transport: "stdio", endpoint: (typeof v.command === "string" && v.command.trim()) || "claude mcp serve", cwd },
    };
  }
  return { mode: "mcp", server: { name: "dev-harness", transport: claudeRunMode, endpoint: (v.url as string) || "" } };
}
