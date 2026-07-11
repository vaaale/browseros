import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { listEpisodes, type Episode, type EpisodeMeta } from "@/lib/agent/memory/episodes";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

export const dynamic = "force-dynamic";

// Meta shape returned by this API — extends the internal EpisodeMeta with the
// on-disk filename (used as the addressable id in /api/memory/episodes/:filename)
// so the client doesn't have to reconstruct it from createdAt + conversationId.
export interface EpisodeMetaView extends EpisodeMeta {
  filename: string;
}

function toView(ep: Episode): EpisodeMetaView {
  return { ...ep.meta, filename: path.posix.basename(ep.path) };
}

// GET /api/memory/episodes  →  { pending: EpisodeMetaView[], consolidated: EpisodeMetaView[] }
//   Includes consolidated episodes (listEpisodes filters them out by default).
export async function GET(req: NextRequest) {
  const agentId = new URL(req.url).searchParams.get("agent")?.trim() || DEFAULT_AGENT_ID;
  try {
    const all = await listEpisodes(agentId, { includeConsolidated: true });
    const pending: EpisodeMetaView[] = [];
    const consolidated: EpisodeMetaView[] = [];
    for (const ep of all) {
      const view = toView(ep);
      if (ep.meta.status === "consolidated") consolidated.push(view);
      else pending.push(view);
    }
    return NextResponse.json({ pending, consolidated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
