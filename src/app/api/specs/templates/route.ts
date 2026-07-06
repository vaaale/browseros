import { NextRequest, NextResponse } from "next/server";
import * as specfs from "@/lib/dev/spec-fs";

export const dynamic = "force-dynamic";

// Read-only access to the spec-kit engine templates under .specify/templates.
// Backs the client-side spec_template_read/list actions (context "both").
// GET /api/specs/templates?path=<rel>     -> { path, content }
// GET /api/specs/templates?list=<subdir>  -> { entries }
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const list = url.searchParams.get("list");
  try {
    if (path) {
      return NextResponse.json({ path, content: await specfs.readTemplate(path) });
    }
    return NextResponse.json({ entries: await specfs.listTemplates(list ?? "") });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}