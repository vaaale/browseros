import { NextRequest, NextResponse } from "next/server";
import {
  listCatalog,
  addMarketplace,
  removeMarketplace,
  syncMarketplace,
  adoptSpec,
  installApp,
} from "@/lib/marketplace/client";

// Marketplace API (028). GET lists registered marketplaces + their items; POST
// carries an `op` (add / remove / sync / adopt-spec). All heavy lifting +
// validation lives in the client; this is a thin, error-safe boundary.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ marketplaces: await listCatalog() });
}

export async function POST(req: NextRequest) {
  let body: { op?: string; url?: string; id?: string; itemId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    switch (body.op) {
      case "add":
        if (!body.url) return NextResponse.json({ error: "url is required" }, { status: 400 });
        return NextResponse.json({ marketplace: await addMarketplace(body.url) });
      case "remove":
        if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
        await removeMarketplace(body.id);
        return NextResponse.json({ ok: true });
      case "sync":
        if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
        await syncMarketplace(body.id);
        return NextResponse.json({ ok: true });
      case "adopt-spec":
        if (!body.id || !body.itemId) {
          return NextResponse.json({ error: "id and itemId are required" }, { status: 400 });
        }
        return NextResponse.json({ adopted: await adoptSpec(body.id, body.itemId) });
      case "install-app":
        if (!body.id || !body.itemId) {
          return NextResponse.json({ error: "id and itemId are required" }, { status: 400 });
        }
        return NextResponse.json({ installed: await installApp(body.id, body.itemId) });
      default:
        return NextResponse.json({ error: `unknown op: ${body.op}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
