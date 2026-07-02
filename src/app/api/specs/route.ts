import { NextRequest, NextResponse } from "next/server";
import * as specfs from "@/lib/dev/spec-fs";
import { listSpecifications, getSpecification, specTree, parseTasks } from "@/lib/specs/pipeline";
import { getStore } from "@/lib/specs/stores";
import { promoteCandidate, discardCandidate, hasCandidate } from "@/lib/specs/store-git";

export const dynamic = "force-dynamic";

// Paths are STORE-PREFIXED (`<storeId>/<rel>`), 018-external-spec-store.
// GET /api/specs                   -> { tree, specs }   (groups per store + status)
// GET /api/specs?id=<store/feature>-> { spec }
// GET /api/specs?path=<store/rel>  -> { path, content, tasks? }
// PUT /api/specs { path, content } -> { path }          (write; refused for read-only stores)
// POST /api/specs { action, store }-> promote | discard the store's spec candidate
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "");
    const storeId = String(body.store ?? "");
    const store = await getStore(storeId);
    if (!store) return NextResponse.json({ error: `Unknown spec store "${storeId}"` }, { status: 404 });
    if (!store.requiresPromote) {
      return NextResponse.json({ error: `Store "${storeId}" does not use promote (commit-on-save).` }, { status: 400 });
    }
    if (action === "promote") return NextResponse.json(await promoteCandidate(store.root));
    if (action === "discard") return NextResponse.json(await discardCandidate(store.root));
    if (action === "status") return NextResponse.json({ hasCandidate: await hasCandidate(store.root) });
    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
