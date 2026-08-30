import { NextRequest, NextResponse } from "next/server";
import { installItem, pickIcon } from "@/lib/apps/store";
import { readProjectDir } from "@/lib/apps/build";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Build + install a multi-facet ITEM project the developer sub-agent authored
// into a staging directory. The staging directory root IS the item root — its
// top-level layout is app/, services/, config/, etc., matching the on-disk
// item layout exactly (user-specs/002-service-daemons). The server reads that
// dir, bundles any app facet's entry with esbuild, installs/activates any
// service facet, and installs the whole item (as a draft, so it lands on the
// caller's active feature branch and promotes with it). This is the orchestration behind
// the assistant's buildApp — and it is NOT app-only: a services-only item (no
// app/ at all) is a fully valid build.
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

    // Resolve the app build entry (relative to the app/ facet): explicit, else
    // the conventional app/src/main.{tsx,ts}. Absent entirely when the staged
    // item has no app facet at all (e.g. a services-only item).
    const entry =
      (typeof body.entry === "string" && body.entry.trim() && body.entry.trim()) ||
      (files["app/src/main.tsx"] ? "src/main.tsx" : files["app/src/main.ts"] ? "src/main.ts" : undefined);
    // App-facet source files are inputs to the build; the build generates the
    // served index.html, so drop any hand-written one to avoid confusion.
    if (entry) delete files["app/index.html"];

    const icon = body.icon ? String(body.icon) : pickIcon(name);
    const branch = await getConversationActiveFeatureBranch(String(body.conversationId ?? ""));
    if (!branch) {
      return NextResponse.json(
        { error: "Building an app needs an active feature branch — call dev_branch_request to set one up, then retry." },
        { status: 400 },
      );
    }
    const result = await installItem({ name, icon, files, entry }, { draft: true, branch });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
