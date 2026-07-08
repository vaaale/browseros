import { NextRequest, NextResponse } from "next/server";
import { installApp, pickIcon } from "@/lib/apps/store";
import { readProjectDir } from "@/lib/apps/build";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Build + install a multi-file app PROJECT the developer sub-agent authored into
// a staging directory. The server reads that dir, then installs (as a draft so
// it lands on the app-candidate branch under the Supervisor) — bundling the
// entry with esbuild. This is the orchestration behind the assistant's buildApp.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const dir = String(body.dir ?? "").trim();
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    if (!dir) return NextResponse.json({ error: "dir (the project staging directory) is required" }, { status: 400 });

    const files = await readProjectDir(dir);
    if (Object.keys(files).length === 0) {
      return NextResponse.json({ error: `no readable project files found in ${dir}` }, { status: 400 });
    }

    // Resolve the build entry: explicit, else the conventional src/main.{tsx,ts}.
    const entry =
      (typeof body.entry === "string" && body.entry.trim() && body.entry.trim()) ||
      (files["src/main.tsx"] ? "src/main.tsx" : files["src/main.ts"] ? "src/main.ts" : undefined);
    if (!entry) {
      return NextResponse.json({ error: "no entry given and no src/main.tsx|ts found" }, { status: 400 });
    }
    // Project files are sources; the build generates the served index.html, so
    // drop any hand-written one to avoid confusion.
    delete files["index.html"];

    const icon = body.icon ? String(body.icon) : pickIcon(name);
    const manifest = await installApp({ name, icon, files, entry }, { draft: true });
    return NextResponse.json({ app: manifest });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
