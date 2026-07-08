import { NextRequest, NextResponse } from "next/server";
import { readApp, setAppCapabilities, toManifest } from "@/lib/apps/store";
import type { AppCapability } from "@/os/types";

export const dynamic = "force-dynamic";

const VALID_CAPS = new Set<AppCapability>(["fs:read", "fs:write", "settings:read", "notify", "window:title"]);

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const app = await readApp(id);
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });
  return NextResponse.json({ id, capabilities: app.capabilities ?? [] });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.capabilities)) {
    return NextResponse.json({ error: "capabilities must be an array" }, { status: 400 });
  }
  const caps = (body.capabilities as string[]).filter((c): c is AppCapability => VALID_CAPS.has(c as AppCapability));
  const manifest = await setAppCapabilities(id, caps);
  if (!manifest) return NextResponse.json({ error: "App not found" }, { status: 404 });
  return NextResponse.json({ app: manifest });
}
