import { NextRequest, NextResponse } from "next/server";
import * as specfs from "@/lib/dev/spec-fs";
import { listSpecifications, getSpecification, specTree, parseTasks } from "@/lib/specs/pipeline";

export const dynamic = "force-dynamic";

// GET /api/specs                 -> { tree, specs }   (left panel + pipeline status)
// GET /api/specs?id=<feature>    -> { spec }          (one specification with status)
// GET /api/specs?path=<rel>      -> { path, content, tasks? }  (one artifact)
// PUT /api/specs { path, content } -> { path }        (atomic write, jailed to specs/.specify)
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const id = url.searchParams.get("id");
  try {
    if (path) {
      const content = await specfs.readFile(path);
      const tasks = path.endsWith("tasks.md") ? parseTasks(content) : undefined;
      return NextResponse.json({ path, content, tasks });
    }
    if (id) {
      return NextResponse.json({ spec: await getSpecification(id) });
    }
    const [tree, specs] = await Promise.all([specTree(), listSpecifications()]);
    return NextResponse.json({ tree, specs });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const path = String(body.path ?? "");
    if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
    const written = await specfs.writeFile(path, String(body.content ?? ""));
    return NextResponse.json({ path: written });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
