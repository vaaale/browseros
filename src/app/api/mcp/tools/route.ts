import { NextRequest, NextResponse } from "next/server";
import { findTools, listServerTools, callServerTool } from "@/lib/mcp/gateway";

export const dynamic = "force-dynamic";

// The MCP tool gateway endpoint (014-mcp-tool-gateway). `agent` scopes to that
// agent's allowed servers (defaults to the active agent).
//   GET ?server=<name>      → that server's tools (name + description + schema)
//   GET ?find=<query>       → tools matching the query across allowed servers
//   POST { server, tool, args } → execute a tool, returns its result
export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams;
  const agent = p.get("agent") || undefined;
  const server = p.get("server");
  if (server) return NextResponse.json(await listServerTools(server, agent));
  return NextResponse.json(await findTools(p.get("find") ?? "", agent));
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { server?: string; tool?: string; args?: unknown; agent?: string };
    if (!body.server || !body.tool) {
      return NextResponse.json({ error: "server and tool are required" }, { status: 400 });
    }
    return NextResponse.json(await callServerTool(body.server, body.tool, body.args, body.agent));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
