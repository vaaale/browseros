import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { serviceRegistry } from "@/core/service/ServiceRegistry";
import { mimeForPath } from "@/lib/mime";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";

// Serves a service's custom Settings config UI — a self-contained HTML file
// declared via manifest.settingsRegistration.configApp (a path relative to the
// item's own directory, e.g. "templates/config.html"). Loaded in an iframe by
// ServiceConfigPanel.tsx in place of the generic schema-driven panel.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const def = serviceRegistry().getService(id);
    if (!def) return NextResponse.json({ error: "unknown or not-installed service" }, { status: 404 });

    const configApp = def.manifest.settingsRegistration?.configApp;
    if (!configApp) return NextResponse.json({ error: "service has no configApp" }, { status: 404 });

    // Path-escape jail: resolve under the item's own directory and reject
    // anything that would climb out (e.g. ".." segments).
    const root = path.resolve(def.itemPath);
    const target = path.resolve(root, configApp);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return NextResponse.json({ error: "invalid configApp path" }, { status: 400 });
    }

    const data = await fs.readFile(target);
    return new NextResponse(new Uint8Array(data), {
      headers: { "Content-Type": mimeForPath(target), "Cache-Control": "no-store" },
    });
  } catch (err) {
    logger().error("services.api", `GET /api/services/${id}/config-app failed`, err);
    return NextResponse.json({ error: "configApp file not found" }, { status: 404 });
  }
}
