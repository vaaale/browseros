import { NextRequest, NextResponse } from "next/server";
import { generateApp } from "@/lib/devharness/generate";
import { installApp } from "@/lib/apps/store";
import { probeMcpServer } from "@/lib/mcp/client";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HARNESS_URL = process.env.BOS_DEV_HARNESS_URL || "http://wingman.akhbar.home:7272/mcp";

export async function GET() {
  const result = await probeMcpServer({ name: "dev-harness", endpoint: HARNESS_URL });
  return NextResponse.json({ harnessUrl: HARNESS_URL, ...result });
}

function deriveName(spec: string): string {
  const words = spec.trim().split(/\s+/).slice(0, 4).join(" ");
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 40) || "New App";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.spec) return NextResponse.json({ error: "spec is required" }, { status: 400 });
    const generated = await generateApp(String(body.spec));
    const name = body.name ? String(body.name) : deriveName(String(body.spec));
    const app = await installApp({ name, icon: body.icon || "Puzzle", files: { "index.html": generated.html } });
    return NextResponse.json({ app, source: generated.source, note: generated.note });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
