import "server-only";
import { getRegistration } from "@/lib/config/registry";
import type { McpServerConfig } from "@/lib/mcp/types";

// How the Claude developer sub-agent is run (Settings → Dev Harness):
//  - "cli": spawn Claude Code headless (`claude -p`) in the repo. Claude itself
//    is the autonomous coding agent — this is the path that actually lets Claude
//    (not the local provider) modify BOS. Default.
//  - "mcp": connect to a Claude Code MCP harness (stdio `claude mcp serve` or a
//    remote HTTP/SSE server) and drive its Agent tool. Kept for remote setups.
export type HarnessConfig =
  | { mode: "cli"; cwd: string }
  | { mode: "mcp"; server: McpServerConfig };

export async function getHarnessConfig(): Promise<HarnessConfig> {
  const reg = getRegistration("dev-harness");
  const v = (reg ? await reg.load() : {}) as Record<string, unknown>;
  const transport = ["cli", "stdio", "http", "sse"].includes(v.transport as string) ? (v.transport as string) : "cli";
  const cwd = (typeof v.cwd === "string" && v.cwd.trim()) || process.cwd();

  if (transport === "cli") return { mode: "cli", cwd };
  if (transport === "stdio") {
    return {
      mode: "mcp",
      server: { name: "dev-harness", transport: "stdio", endpoint: (typeof v.command === "string" && v.command.trim()) || "claude mcp serve", cwd },
    };
  }
  return { mode: "mcp", server: { name: "dev-harness", transport: transport as "http" | "sse", endpoint: (v.url as string) || "" } };
}
