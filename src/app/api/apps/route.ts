import { NextRequest, NextResponse } from "next/server";
import { listInstalledApps, installItem, uninstallApp, purgeApp, pickIcon } from "@/lib/apps/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ apps: await listInstalledApps() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

    // Accept a full item-root-relative files map (multi-facet: app/, services/,
    // config/, ...) or a convenience single html string (wrapped as the app facet).
    const files: Record<string, string> =
      body.files && typeof body.files === "object"
        ? (body.files as Record<string, string>)
        : body.html
          ? { "app/index.html": String(body.html) }
          : {};
    const entry = typeof body.entry === "string" && body.entry.trim() ? body.entry.trim() : undefined;

    const icon = body.icon ? String(body.icon) : pickIcon(String(body.name));
    // draft: install onto the app-candidate branch (previewable) instead of live.
    const result = await installItem({ name: String(body.name), icon, files, entry }, { draft: body.draft === true });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Soft uninstall by default (keeps files); ?purge=1 permanently deletes the files.
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  const purge = url.searchParams.get("purge") === "1" || url.searchParams.get("purge") === "true";
  try {
    const apps = purge ? await purgeApp(id) : await uninstallApp(id);
    return NextResponse.json({ apps });
  } catch (err) {
    // e.g. purging an item whose service is still installed
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Uninstall is final under 035 — an uninstalled app is gone, and reinstalling
// is a Marketplace action. There is no restore endpoint.
