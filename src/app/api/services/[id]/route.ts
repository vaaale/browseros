import { NextRequest, NextResponse } from "next/server";
import { serviceManager } from "@/core/service/ServiceManager";
import { serviceRegistry } from "@/core/service/ServiceRegistry";
import { toServiceStatusView } from "@/core/service/types";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";

// GET — single service detail, including `corruptedReason` when the service's
// service.json was deleted/invalidated after install (T0052).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const registry = serviceRegistry();
    await registry.discoverServices();
    const def = registry.getService(id);
    if (!def) return NextResponse.json({ error: "unknown or not-installed service" }, { status: 404 });
    return NextResponse.json({ service: toServiceStatusView(def) });
  } catch (err) {
    logger().error("services.api", `GET /api/services/${id} failed`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST { action: "start" | "stop" | "restart", reason?, startupTimeout?, shutdownTimeout? }
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = await req.json().catch(() => ({}));
    const { action, reason, startupTimeout, shutdownTimeout } = body as {
      action?: string;
      reason?: string;
      startupTimeout?: number;
      shutdownTimeout?: number;
    };
    const manager = serviceManager();

    switch (action) {
      case "start":
        await manager.start(id, { startupTimeout });
        break;
      case "stop":
        await manager.stop(id, { shutdownTimeout });
        break;
      case "restart":
        await manager.restart(id, reason);
        break;
      default:
        return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, state: manager.getStatus(id) });
  } catch (err) {
    logger().error("services.api", `POST /api/services/${id} failed`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
