import { NextRequest, NextResponse } from "next/server";
import { memorySearch } from "@/lib/agent/memory/search";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

export const dynamic = "force-dynamic";

// GET /api/memory/search?agent=<id>&q=<query>&maxResults=<n>
//   Substring/word-match search over an agent's topic shards + episodes.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent")?.trim() || DEFAULT_AGENT_ID;
  const query = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").trim();
  const max = Number(url.searchParams.get("maxResults") ?? "10");
  if (!query) return NextResponse.json({ error: "q is required" }, { status: 400 });
  const results = await memorySearch(agentId, query, Number.isFinite(max) && max > 0 ? max : 10);
  return NextResponse.json({ query, results });
}
