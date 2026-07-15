import "server-only";
import fs from "fs";
import path from "path";
import { getRegistration } from "@/lib/config/registry";
import { dataDir } from "@/os/data-dir";
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

export function hasClaudeCreds(): boolean {
  return fs.existsSync(claudeCredsPath());
}

export function hasOpenCodeAuth(): boolean {
  return fs.existsSync(openCodeAuthPath());
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

export function clearClaudeCreds(): void {
  fs.rmSync(claudeCredsPath(), { force: true });
}

export function clearOpenCodeAuth(): void {
  fs.rmSync(openCodeAuthPath(), { force: true });
}

/**
 * Environment overrides for spawning the headless CLIs. Points HOME at the
 * harness home ONLY when credentials have actually been provisioned, so local
 * dev with a real ~/.claude keeps working when nothing is configured.
 */
export function harnessCredentialEnv(): Record<string, string> {
  if (!hasClaudeCreds() && !hasOpenCodeAuth()) return {};
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
  | { mode: "cli"; tool: "claude" | "opencode"; cwd: string }
  | { mode: "mcp"; server: McpServerConfig };

export async function getHarnessConfig(): Promise<HarnessConfig> {
  const reg = getRegistration("dev-harness");
  const v = (reg ? await reg.load() : {}) as Record<string, unknown>;
  const transport = ["cli", "opencode", "stdio", "http", "sse"].includes(v.transport as string) ? (v.transport as string) : "cli";
  const cwd = process.cwd();

  if (transport === "cli") return { mode: "cli", tool: "claude", cwd };
  if (transport === "opencode") return { mode: "cli", tool: "opencode", cwd };
  if (transport === "stdio") {
    return {
      mode: "mcp",
      server: { name: "dev-harness", transport: "stdio", endpoint: (typeof v.command === "string" && v.command.trim()) || "claude mcp serve", cwd },
    };
  }
  return { mode: "mcp", server: { name: "dev-harness", transport: transport as "http" | "sse", endpoint: (v.url as string) || "" } };
}
