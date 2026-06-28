import { NextRequest, NextResponse } from "next/server";
import { docsTree, getDoc, isSection } from "@/lib/docs/store";

export const dynamic = "force-dynamic";

// Read-only access to the project documentation tree (docs/usage + docs/dev).
// - GET                          -> { tree: { usage: DocNode[], dev: DocNode[] } }
// - GET ?section=usage&path=...  -> { doc: { section, path, title, content } }
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const section = url.searchParams.get("section");
  const docPath = url.searchParams.get("path");

  if (section || docPath) {
    if (!section || !isSection(section)) {
      return NextResponse.json({ error: "a valid 'section' (usage|dev) is required" }, { status: 400 });
    }
    if (!docPath) {
      return NextResponse.json({ error: "'path' is required when 'section' is given" }, { status: 400 });
    }
    const doc = await getDoc(section, docPath);
    if (!doc) return NextResponse.json({ error: "document not found" }, { status: 404 });
    return NextResponse.json({ doc });
  }

  return NextResponse.json({ tree: await docsTree() });
}
