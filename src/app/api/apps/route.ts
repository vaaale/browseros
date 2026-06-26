import { NextRequest, NextResponse } from "next/server";
import { listInstalledApps, installApp, uninstallApp } from "@/lib/apps/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ apps: await listInstalledApps() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

    // Accept either a full files map or a single html string for convenience.
    const files: Record<string, string> =
      body.files && typeof body.files === "object"
        ? body.files
        : body.html
          ? { "index.html": String(body.html) }
          : {};
    if (!files["index.html"]) return NextResponse.json({ error: "index.html (or html) is required" }, { status: 400 });

    const manifest = await installApp({ name: String(body.name), icon: body.icon, files });
    return NextResponse.json({ app: manifest });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  return NextResponse.json({ apps: await uninstallApp(id) });
}
