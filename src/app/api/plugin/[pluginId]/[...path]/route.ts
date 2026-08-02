import { NextRequest, NextResponse } from "next/server";
import { matchRoute, isPluginRegistered } from "@/lib/bos-plugins/route-registry";
import type { PluginRouteContext } from "@/lib/bos-plugins/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildHandler(method: string) {
  return async function handler(
    req: NextRequest,
    { params }: { params: Promise<{ pluginId: string; path: string[] }> },
  ) {
    const { pluginId, path: pathSegments } = await params;
    const path = "/" + pathSegments.join("/");

    if (!isPluginRegistered(pluginId)) {
      return NextResponse.json(
        { error: `Plugin '${pluginId}' is not installed or active.` },
        { status: 404 },
      );
    }

    const routeHandler = matchRoute(pluginId, method, path);
    if (!routeHandler) {
      return NextResponse.json(
        { error: `No handler for ${method} ${path} in plugin '${pluginId}'.` },
        { status: 404 },
      );
    }

    const ctx: PluginRouteContext = {
      pluginId,
      log: {
        info: (msg) => console.log(`[plugin:${pluginId}] ${msg}`),
        warn: (msg) => console.warn(`[plugin:${pluginId}] ${msg}`),
        error: (msg) => console.error(`[plugin:${pluginId}] ${msg}`),
      },
    };

    try {
      return await routeHandler(req, ctx);
    } catch (err) {
      console.error(`[plugin:${pluginId}] Route error on ${method} ${path}:`, err);
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  };
}

export const GET = buildHandler("GET");
export const POST = buildHandler("POST");
export const PUT = buildHandler("PUT");
export const DELETE = buildHandler("DELETE");
export const PATCH = buildHandler("PATCH");
