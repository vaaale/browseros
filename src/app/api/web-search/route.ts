import { NextRequest, NextResponse } from "next/server";
import { validateWebSearchInput, webSearch } from "@/lib/agent/web-search";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;
const buckets = new Map<string, number[]>();

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
    }

    const rateLimited = checkRateLimit(clientKey(req));
    if (rateLimited) {
      return NextResponse.json({ error: `Too many web searches. Try again in ${rateLimited} seconds.` }, { status: 429 });
    }

    const input = validateWebSearchInput(await req.json());
    return NextResponse.json({ result: await webSearch(input) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "local";
}

function checkRateLimit(key: string): number | null {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    buckets.set(key, recent);
    return Math.ceil((WINDOW_MS - (now - recent[0])) / 1000);
  }
  recent.push(now);
  buckets.set(key, recent);
  return null;
}
