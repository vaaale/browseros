import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { listInstalledItems, itemLinkPath } from "@/system/items/installed";

// Installed state, as the shared scanner sees it (035). This is the read surface
// for item shapes that have no registry of their own: an app lands in /api/apps
// and a service in /api/services, but a PLUGIN-only item — a voice engine, an
// integration — was invisible everywhere, so it looked uninstalled while being
// perfectly installed and active.
export const dynamic = "force-dynamic";

export interface InstalledItemView {
  id: string;
  name: string;
  description: string;
  version?: string;
  facets: string[];
  origin: "local" | "marketplace";
  marketplaceId?: string;
  broken: boolean;
}

/** A plugin's own manifest is the best name we have for a plugin-only item —
 *  there is no app.json to read, and the id alone reads like a slug. */
async function pluginMeta(id: string): Promise<{ name?: string; description?: string; version?: string }> {
  try {
    const raw = await fs.readFile(path.join(itemLinkPath(id), "plugin", "bos-plugin.json"), "utf8");
    const m = JSON.parse(raw) as { name?: string; description?: string; version?: string };
    return { name: m.name, description: m.description, version: m.version };
  } catch {
    return {};
  }
}

function toDisplayName(slug: string): string {
  return slug.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export async function GET() {
  try {
    const items = await listInstalledItems();
    const views: InstalledItemView[] = await Promise.all(
      items.map(async (i) => {
        const meta = i.facets.plugin && !i.broken ? await pluginMeta(i.id) : {};
        return {
          id: i.id,
          name: meta.name || toDisplayName(i.id),
          description: meta.description ?? "",
          version: meta.version,
          facets: Object.entries(i.facets).filter(([, present]) => present).map(([facet]) => facet),
          origin: i.origin,
          marketplaceId: i.marketplaceId,
          broken: i.broken,
        };
      }),
    );
    return NextResponse.json({ items: views });
  } catch (err) {
    return NextResponse.json({ items: [], error: (err as Error).message }, { status: 500 });
  }
}
