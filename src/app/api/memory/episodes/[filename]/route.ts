import { NextRequest, NextResponse } from "next/server";
import path from "path";
import {
  deleteEpisodeByFilename,
  getEpisodeByFilename,
  type Episode,
  type EpisodeMeta,
} from "@/lib/agent/memory/episodes";

export const dynamic = "force-dynamic";

interface EpisodeView {
  meta: EpisodeMeta & { filename: string };
  sections: Episode["sections"];
  path: string;
}

function toView(ep: Episode): EpisodeView {
  return {
    meta: { ...ep.meta, filename: path.posix.basename(ep.path) },
    sections: ep.sections,
    path: ep.path,
  };
}

// GET /api/memory/episodes/:filename  →  Episode (full content + sections)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  try {
    const ep = await getEpisodeByFilename(filename);
    if (!ep) return NextResponse.json({ error: `Episode not found: ${filename}` }, { status: 404 });
    return NextResponse.json(toView(ep));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// DELETE /api/memory/episodes/:filename  →  { success: true }
//   Callers are expected to confirm on the client; the server just deletes.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  try {
    const deleted = await deleteEpisodeByFilename(filename);
    if (!deleted) return NextResponse.json({ error: `Episode not found: ${filename}` }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
