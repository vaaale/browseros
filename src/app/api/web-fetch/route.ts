import { NextRequest, NextResponse } from "next/server";
import { fetchText } from "@/lib/net";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Fetches a URL's readable text content. Backs the client-side web_fetch action
// (context "both"). Server-only because it bypasses browser CORS and jails URL
// handling to fetchText's size/format limits.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = String(body?.url ?? "");
    if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });
    return NextResponse.json({ result: await fetchText(url) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}