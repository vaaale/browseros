import { NextResponse } from "next/server";
import * as vfs from "@/os/vfs";
import { getTopic, listTopicSlugs, TOPICS_DIR } from "@/lib/agent/memory/topics";
import { getMemoryLoopsConfig } from "@/lib/agent/memory/config";

export const dynamic = "force-dynamic";

export interface TopicMetaView {
  slug: string;
  entryCount: number;
  charUsage: number;
  budget: number;
}

// GET /api/memory/topics  →  { topics: TopicMetaView[] }
//   One entry per <slug>.md under /Documents/Memory/Topics/. `charUsage` is the
//   on-disk character count (== the value the topic-budget check enforces).
export async function GET() {
  try {
    const [slugs, { topicBudget }] = await Promise.all([
      listTopicSlugs(),
      getMemoryLoopsConfig(),
    ]);
    const topics: TopicMetaView[] = [];
    for (const slug of slugs) {
      const topic = await getTopic(slug);
      if (!topic) continue;
      let charUsage = 0;
      try {
        const raw = await vfs.readText(`${TOPICS_DIR}/${slug}.md`);
        charUsage = raw.length;
      } catch {
        charUsage = 0;
      }
      topics.push({
        slug: topic.slug,
        entryCount: topic.entries.length,
        charUsage,
        budget: topicBudget,
      });
    }
    topics.sort((a, b) => a.slug.localeCompare(b.slug));
    return NextResponse.json({ topics });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
