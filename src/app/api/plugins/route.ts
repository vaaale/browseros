import { NextRequest, NextResponse } from "next/server";
import { getPluginsForSettings, savePluginSettings, setPluginOrder } from "@/lib/plugins/settings";
import { uninstallPlugin } from "@/lib/plugins/loader";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const plugins = await getPluginsForSettings();
    return NextResponse.json({ plugins });
  } catch (err) {
    logger().error("plugins.api", "GET /api/plugins failed", undefined, { error: (err as Error).message });
    return NextResponse.json({ plugins: [], error: (err as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { pluginId, active, config, order } = body as {
      pluginId?: string;
      active?: boolean;
      config?: Record<string, unknown>;
      order?: number;
    };
    if (!pluginId) return NextResponse.json({ error: "pluginId is required" }, { status: 400 });
    await savePluginSettings(pluginId, { active, config, order });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger().error("plugins.api", "PATCH /api/plugins failed", undefined, { error: (err as Error).message });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { orderedIds } = body as { orderedIds?: string[] };
    if (!Array.isArray(orderedIds)) return NextResponse.json({ error: "orderedIds array is required" }, { status: 400 });
    await setPluginOrder(orderedIds);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger().error("plugins.api", "PUT /api/plugins failed", undefined, { error: (err as Error).message });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { pluginId } = body as { pluginId?: string };
    if (!pluginId) return NextResponse.json({ error: "pluginId is required" }, { status: 400 });
    await uninstallPlugin(pluginId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger().error("plugins.api", "DELETE /api/plugins failed", undefined, { error: (err as Error).message });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
