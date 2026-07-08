import { NextRequest, NextResponse } from "next/server";
import { memorySearch } from "@/lib/agent/memory/search";

export const dynamic = "force-dynamic";

// GET /api/memory/search?q=<query>&maxResults=<n>
//   Substring/word-match search over topic shards + episodes. See spec 021 FR-017.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").trim();
  const max = Number(url.searchParams.get("maxResults") ?? "10");
  if (!query) return NextResponse.json({ error: "q is required" }, { status: 400 });
  const results = await memorySearch(query, Number.isFinite(max) && max > 0 ? max : 10);
  return NextResponse.json({ query, results });
}
