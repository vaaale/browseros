import { NextRequest, NextResponse } from "next/server";
import {
  listCatalog,
  addMarketplace,
  removeMarketplace,
  syncMarketplace,
  adoptSpec,
  installSkill,
  installMarketplaceItem,
  uninstallBosPlugin,
  uninstallMarketplaceItem,
} from "@/lib/marketplace/client";
import { listInstalledItems } from "@/system/items/installed";

// Marketplace API (028). GET lists registered marketplaces + their items; POST
// carries an `op` (add / remove / sync / adopt-spec). All heavy lifting +
// validation lives in the client; this is a thin, error-safe boundary.
export const dynamic = "force-dynamic";

/** Ids of every installed item, from the one shared scanner (035) — the only
 *  answer to "is this installed" that works for a facet with no registry of its
 *  own, such as a plugin. */
async function listInstalledItemIds(): Promise<string[]> {
  return (await listInstalledItems()).filter((i) => !i.broken).map((i) => i.id);
}

export async function GET() {
  // installedItemIds travels ALONGSIDE the catalog rather than as a flag on each
  // item: MarketplaceItem is the manifest's own schema and gets serialized back to
  // disk, so runtime state must never be attached to it.
  const [marketplaces, installedItemIds] = await Promise.all([listCatalog(), listInstalledItemIds()]);
  return NextResponse.json({ marketplaces, installedItemIds });
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
      case "install-item":
        if (!body.id || !body.itemId) {
          return NextResponse.json({ error: "id and itemId are required" }, { status: 400 });
        }
        return NextResponse.json({ installed: await installMarketplaceItem(body.id, body.itemId) });
      case "install-skill":
        if (!body.id || !body.itemId) {
          return NextResponse.json({ error: "id and itemId are required" }, { status: 400 });
        }
        return NextResponse.json({ installed: await installSkill(body.id, body.itemId) });
      case "uninstall-item":
        if (!body.itemId) return NextResponse.json({ error: "itemId is required" }, { status: 400 });
        await uninstallMarketplaceItem(body.itemId);
        return NextResponse.json({ ok: true });
      case "uninstall-plugin":
        if (!body.id) return NextResponse.json({ error: "id (pluginId) is required" }, { status: 400 });
        await uninstallBosPlugin(body.id);
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: `unknown op: ${body.op}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
