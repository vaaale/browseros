import { NextResponse } from "next/server";
import { detectDataFsCapabilities, bestMethod } from "@/lib/datafs/probe";

export const dynamic = "force-dynamic";

// Exposes the data-isolation capability probe so Settings can offer only
// compatible isolation methods and default to the best one
// (specs/006-data-isolation/spec.md §4–§5).
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("reprobe") === "1";
  const caps = await detectDataFsCapabilities(force);
  return NextResponse.json({ ...caps, recommended: bestMethod(caps) });
}
