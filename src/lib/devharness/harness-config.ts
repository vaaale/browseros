import "server-only";
import { getRegistration } from "@/lib/config/registry";
import type { McpServerConfig } from "@/lib/mcp/types";

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
