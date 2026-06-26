import { NextRequest, NextResponse } from "next/server";
import { listMcpServers, addMcpServer, removeMcpServer } from "@/lib/mcp/store";
import { probeMcpServer } from "@/lib/mcp/client";
import type { McpServerConfig } from "@/lib/mcp/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const probe = new URL(req.url).searchParams.get("probe");
  const servers = await listMcpServers();
  if (probe) {
    const cfg = servers.find((s) => s.endpoint === probe) ?? { name: probe, endpoint: probe };
    return NextResponse.json({ result: await probeMcpServer(cfg) });
  }
  return NextResponse.json({ servers });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<McpServerConfig>;
    if (!body.endpoint) return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
    const cfg: McpServerConfig = {
      name: body.name || new URL(body.endpoint).host,
      endpoint: body.endpoint,
      apiKey: body.apiKey,
      transport: body.transport === "sse" ? "sse" : "http",
    };
    return NextResponse.json({ servers: await addMcpServer(cfg) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (!endpoint) return NextResponse.json({ error: "endpoint query param required" }, { status: 400 });
  return NextResponse.json({ servers: await removeMcpServer(endpoint) });
}
