import { NextRequest, NextResponse } from "next/server";
import { serviceRegistry } from "@/core/service/ServiceRegistry";
import { installService, uninstallService } from "@/system/marketplace/install/serviceInstaller";
import { logger } from "@/lib/logging";
import { toServiceStatusView } from "@/core/service/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const registry = serviceRegistry();
    await registry.discoverServices();
    const services = registry.getAllServices().map(toServiceStatusView);
    return NextResponse.json({ services });
  } catch (err) {
    logger().error("services.api", "GET /api/services failed", err);
    return NextResponse.json({ services: [], error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { itemPath, serviceId } = body as { itemPath?: string; serviceId?: string };
    if (!itemPath) return NextResponse.json({ error: "itemPath is required" }, { status: 400 });
    const manifest = await installService(itemPath, serviceId);
    return NextResponse.json({ ok: true, manifest });
  } catch (err) {
    logger().error("services.api", "POST /api/services failed", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { serviceId } = body as { serviceId?: string };
    if (!serviceId) return NextResponse.json({ error: "serviceId is required" }, { status: 400 });
    await uninstallService(serviceId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger().error("services.api", "DELETE /api/services failed", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
