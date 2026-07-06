import { NextRequest, NextResponse } from "next/server";
import * as repo from "@/lib/dev/repo-fs";

export const dynamic = "force-dynamic";

// Read-only access to BOS source. Backs the client-side bos_source_list/read/search
// actions (context "both" in capabilities-registry). Server-only because repo-fs
// uses Node fs and jails paths to the repo root; the sub-agent runner uses the
// same repo-fs helpers directly (see subagents/tools.ts DEV_TOOLS).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const op = String(body?.op ?? "");
    switch (op) {
      case "list": {
        const path = typeof body.path === "string" && body.path ? body.path : ".";
        return NextResponse.json({ result: await repo.listDir(path) });
      }
      case "read": {
        const path = String(body.path ?? "");
        if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
        return NextResponse.json({ result: await repo.readFile(path) });
      }
      case "search": {
        const query = String(body.query ?? "");
        if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });
        const dir = typeof body.dir === "string" && body.dir ? body.dir : undefined;
        return NextResponse.json({ result: await repo.search(query, { dir }) });
      }
      default:
        return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}