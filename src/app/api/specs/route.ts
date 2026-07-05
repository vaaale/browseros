import { NextRequest, NextResponse } from "next/server";
import * as specfs from "@/lib/dev/spec-fs";
import { listSpecifications, getSpecification, specTree, parseTasks } from "@/lib/specs/pipeline";

export const dynamic = "force-dynamic";

// Paths are STORE-PREFIXED (`<storeId>/<rel>`), 018-external-spec-store.
// GET /api/specs                            -> { tree, specs }  (groups per store, incl. draft-branch nodes)
// GET /api/specs?id=<store/feature>         -> { spec }
// GET /api/specs?path=<store/rel>[&branch=] -> { path, content, tasks?, branch? }
//                                              `branch` reads a bos/* draft branch (read-only, no checkout; 020)
// PUT /api/specs { path, content }          -> { path }         (write; refused for read-only stores)
// Spec promotion is branch-coupled to the code promote (020) — no POST actions.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const id = url.searchParams.get("id");
  const branch = url.searchParams.get("branch");
  try {
    if (path) {
      const content = branch ? await specfs.readFileAt(path, branch) : await specfs.readFile(path);
      const tasks = path.endsWith("tasks.md") ? parseTasks(content) : undefined;
      return NextResponse.json({ path, content, tasks, ...(branch ? { branch } : {}) });
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
