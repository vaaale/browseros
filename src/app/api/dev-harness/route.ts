import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getHarnessConfig } from "@/lib/devharness/harness-config";
import { probeMcpServer } from "@/lib/mcp/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const exec = promisify(execFile);

// Connectivity check for the configured dev harness. For CLI mode it verifies the
// selected binary (`claude` or `opencode`) is installed; for MCP modes it connects
// and lists tools.
export async function GET() {
  const h = await getHarnessConfig();
  if (h.mode === "cli") {
    const bin = h.tool === "opencode" ? "opencode" : "claude";
    const label = h.tool === "opencode" ? "OpenCode" : "Claude";
    try {
      const { stdout } = await exec(bin, ["--version"], { timeout: 10_000 });
      return NextResponse.json({ mode: "cli", tool: h.tool, ok: true, version: stdout.trim(), cwd: h.cwd });
    } catch (e) {
      return NextResponse.json({ mode: "cli", tool: h.tool, ok: false, error: `${label} CLI not available: ${(e as Error).message}`, cwd: h.cwd });
    }
  }
  const result = await probeMcpServer(h.server);
  return NextResponse.json({ mode: "mcp", transport: h.server.transport, endpoint: h.server.endpoint, cwd: h.server.cwd, ...result });
}
