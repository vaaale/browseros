import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { serviceRegistry } from "@/core/service/ServiceRegistry";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";

const MAX_BYTES = 512 * 1024; // Cap what a single request returns — the log
// file itself grows unbounded (rotation is handled by the system logging
// layer per NFR-004); the viewer only ever needs a recent tail.

// GET — return the tail of dataDir()/logs/services/<id>.log as plain text.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const def = serviceRegistry().getService(id);
    if (!def) return NextResponse.json({ error: "unknown or not-installed service" }, { status: 404 });

    let content = "";
    try {
      const stat = await fs.stat(def.logsPath);
      const start = Math.max(0, stat.size - MAX_BYTES);
      const handle = await fs.open(def.logsPath, "r");
      try {
        const { buffer, bytesRead } = await handle.read({
          buffer: Buffer.alloc(stat.size - start),
          position: start,
        });
        content = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      content = "";
    }

    return NextResponse.json({ content });
  } catch (err) {
    logger().error("services.api", `GET /api/services/${id}/logs failed`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
