import { NextRequest, NextResponse } from "next/server";
import { listInstalledApps, installApp, uninstallApp, restoreApp, purgeApp, pickIcon } from "@/lib/apps/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ apps: await listInstalledApps() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

    // Accept a full files map (multi-file/built project) or a single html string.
    const files: Record<string, string> =
      body.files && typeof body.files === "object"
        ? (body.files as Record<string, string>)
        : body.html
          ? { "index.html": String(body.html) }
          : {};
    const entry = typeof body.entry === "string" && body.entry.trim() ? body.entry.trim() : undefined;
    if (!entry && !files["index.html"]) {
      return NextResponse.json({ error: "Provide index.html/html (static) or entry + files (built project)" }, { status: 400 });
    }

    const icon = body.icon ? String(body.icon) : pickIcon(String(body.name));
    // draft: install onto the app-candidate branch (previewable) instead of live.
    const manifest = await installApp({ name: String(body.name), icon, files, entry }, { draft: body.draft === true });
    return NextResponse.json({ app: manifest });
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
  const apps = purge ? await purgeApp(id) : await uninstallApp(id);
  return NextResponse.json({ apps });
}

// Restore a previously uninstalled app.
export async function PATCH(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  const app = await restoreApp(id);
  if (!app) return NextResponse.json({ error: `No app "${id}"` }, { status: 404 });
  return NextResponse.json({ app });
}
