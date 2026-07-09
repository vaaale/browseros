import { NextRequest, NextResponse } from "next/server";
import * as vfs from "@/os/vfs";
import { getTopic, listTopicSlugs, topicPath } from "@/lib/agent/memory/topics";
import { getMemoryLoopsConfig } from "@/lib/agent/memory/config";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

export const dynamic = "force-dynamic";

export interface TopicMetaView {
  slug: string;
  digest: string;
  entryCount: number;
  charUsage: number;
  budget: number;
}

// GET /api/memory/topics?agent=<id>  →  { topics: TopicMetaView[] }
export async function GET(req: NextRequest) {
  const agentId = new URL(req.url).searchParams.get("agent")?.trim() || DEFAULT_AGENT_ID;
  try {
    const [slugs, { topicBudget }] = await Promise.all([listTopicSlugs(agentId), getMemoryLoopsConfig()]);
    const topics: TopicMetaView[] = [];
    for (const slug of slugs) {
      const topic = await getTopic(agentId, slug);
      if (!topic) continue;
      let charUsage = 0;
      try {
        charUsage = (await vfs.readText(topicPath(agentId, slug))).length;
      } catch {
        charUsage = 0;
      }
      topics.push({ slug: topic.slug, digest: topic.digest, entryCount: topic.entries.length, charUsage, budget: topicBudget });
    }
    topics.sort((a, b) => a.slug.localeCompare(b.slug));
    return NextResponse.json({ topics });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
