import { NextRequest, NextResponse } from "next/server";
import { archiveEpisodeByFilename } from "@/lib/agent/memory/episodes";

export const dynamic = "force-dynamic";

// POST /api/memory/episodes/:filename/archive  →  { success: true }
//   Moves a single episode file into .Archive/. Never deletes; a mistakenly
//   archived episode can be recovered by moving it back by hand.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  try {
    const archived = await archiveEpisodeByFilename(filename);
    if (!archived) return NextResponse.json({ error: `Episode not found: ${filename}` }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
