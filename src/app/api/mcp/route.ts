import { NextRequest, NextResponse } from "next/server";
import { listMcpServers, addMcpServer, removeMcpServer } from "@/lib/mcp/store";
import { probeMcpServer } from "@/lib/mcp/client";
import type { McpServerConfig } from "@/lib/mcp/types";

export const dynamic = "force-dynamic";

// Build a valid McpServerConfig from a request body, validating per transport.
// Throws (→ 400) on invalid input.
function normalizeConfig(body: Partial<McpServerConfig>): McpServerConfig {
  const transport: McpServerConfig["transport"] =
    body.transport === "sse" ? "sse" : body.transport === "stdio" ? "stdio" : "http";

  const description = body.description?.trim() || undefined;

  if (transport === "stdio") {
    const command = body.command?.trim() || (body.endpoint ?? "").trim().split(/\s+/)[0];
    if (!command) throw new Error('stdio transport requires a command (e.g. "docker" or "npx")');
    const name = body.name?.trim() || command;
    return {
      name,
      description,
      transport,
      command: body.command?.trim() || undefined,
      args: Array.isArray(body.args) ? body.args.filter((a) => typeof a === "string") : undefined,
      env: body.env && typeof body.env === "object" ? body.env : undefined,
      cwd: body.cwd?.trim() || undefined,
      endpoint: body.endpoint?.trim() || undefined,
    };
  }

  if (!body.endpoint) throw new Error("http/sse transport requires an endpoint URL");
  const url = new URL(body.endpoint); // validates the URL
  const name = body.name?.trim() || url.host;
  return {
    name,
    description,
    transport,
    endpoint: body.endpoint,
    apiKey: body.apiKey || undefined,
    headers: body.headers && typeof body.headers === "object" ? body.headers : undefined,
  };
}

export async function GET(req: NextRequest) {
  const probe = new URL(req.url).searchParams.get("probe"); // server name
  const servers = await listMcpServers();
  if (probe) {
    const cfg = servers.find((s) => s.name === probe);
    if (!cfg) return NextResponse.json({ result: { ok: false, error: `No MCP server named "${probe}".` } });
    return NextResponse.json({ result: await probeMcpServer(cfg) });
  }
  return NextResponse.json({ servers });
}

// POST saves (upsert by name). With `{ test: true, … }` it probes the given config
// WITHOUT saving — so the Settings UI can verify a connection before adding it.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<McpServerConfig> & { test?: boolean };
    const cfg = normalizeConfig(body);
    if (body.test) return NextResponse.json({ result: await probeMcpServer(cfg) });
    return NextResponse.json({ servers: await addMcpServer(cfg) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  let name = params.get("name");
  // Back-compat: callers that only know the endpoint can still delete.
  if (!name) {
    const endpoint = params.get("endpoint");
    if (endpoint) name = (await listMcpServers()).find((s) => s.endpoint === endpoint)?.name ?? null;
  }
  if (!name) return NextResponse.json({ error: "name (or endpoint) query param required" }, { status: 400 });
  return NextResponse.json({ servers: await removeMcpServer(name) });
}
