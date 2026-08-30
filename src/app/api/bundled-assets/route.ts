import { NextRequest, NextResponse } from "next/server";
import {
  listPendingBundledAssetConflicts,
  resolvePendingBundledAssetConflict,
} from "@/system/marketplace/install/bundledAssets";
import { logger } from "@/lib/logging";

// Keep-vs-replace decisions for bundled agents/skills a marketplace item ships
// (040-okf-knowledge-base). An item update never overwrites a locally-modified
// copy; it records a conflict here and the user resolves it from Settings.

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ conflicts: await listPendingBundledAssetConflicts() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const kind = body?.kind;
    const id = String(body?.id ?? "").trim();
    const resolution = body?.resolution;
    if (kind !== "agent" && kind !== "skill") {
      return NextResponse.json({ error: "kind must be 'agent' or 'skill'" }, { status: 400 });
    }
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    if (resolution !== "keep" && resolution !== "replace") {
      return NextResponse.json({ error: "resolution must be 'keep' or 'replace'" }, { status: 400 });
    }

    const { resolved } = await resolvePendingBundledAssetConflict(kind, id, resolution);
    if (!resolved) return NextResponse.json({ error: "no such pending conflict" }, { status: 404 });
    logger().info("marketplace.bundled-assets", "conflict.resolved", { kind, id, resolution });
    return NextResponse.json({ ok: true, conflicts: await listPendingBundledAssetConflicts() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
