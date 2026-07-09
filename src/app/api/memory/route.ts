import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { readMemoryDoc, setUserPreferences } from "@/lib/agent/memory/agent-memory";
import {
  addTopicEntry,
  createTopic,
  deleteTopic,
  getTopic,
  listTopicSlugs,
  removeTopicEntry,
  replaceTopicEntry,
} from "@/lib/agent/memory/topics";

export const dynamic = "force-dynamic";

function agentOf(req: NextRequest): string {
  return new URL(req.url).searchParams.get("agent")?.trim() || DEFAULT_AGENT_ID;
}

// GET ?agent=<id>            -> { agentId, preferences, index: [{file, description}], topics: string[] }
// GET ?agent=<id>&topic=<s>  -> { topic, digest, entries: [{ id, text, timestamp }] }
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agentId = agentOf(req);
  const topicSlug = url.searchParams.get("topic")?.trim();
  try {
    if (topicSlug) {
      const topic = await getTopic(agentId, topicSlug);
      if (!topic) return NextResponse.json({ error: `Topic "${topicSlug}" not found` }, { status: 404 });
      return NextResponse.json({
        topic: topic.slug,
        digest: topic.digest,
        entries: topic.entries.map((e) => ({ id: e.id, text: e.text, timestamp: e.timestamp })),
      });
    }
    const [doc, topics] = await Promise.all([readMemoryDoc(agentId), listTopicSlugs(agentId)]);
    return NextResponse.json({ agentId, preferences: doc.preferences, index: doc.index, topics });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// POST body:
//   { agent, action: "setPreferences", content }
//   { agent, target: "topic", topic, action: "add"|"replace"|"remove"|"create", content?, id?, oldText? }
export async function POST(req: NextRequest) {
  const agentId = agentOf(req);
  try {
    const body = await req.json();

    if (body?.action === "setPreferences") {
      await setUserPreferences(agentId, String(body.content ?? ""));
      return NextResponse.json({ success: true });
    }

    if (body?.target === "topic") {
      const slug = typeof body.topic === "string" ? body.topic.trim() : "";
      if (!slug) return NextResponse.json({ success: false, error: "topic slug is required" }, { status: 400 });
      const action = String(body.action ?? "");
      const content = typeof body.content === "string" ? body.content : "";
      const idOrText =
        typeof body.id === "string" || typeof body.id === "number"
          ? String(body.id)
          : typeof body.oldText === "string"
            ? body.oldText
            : "";
      switch (action) {
        case "create":
          return NextResponse.json(await createTopic(agentId, slug, content));
        case "add":
          return NextResponse.json(await addTopicEntry(agentId, slug, content));
        case "replace":
          return NextResponse.json(await replaceTopicEntry(agentId, slug, idOrText, content));
        case "remove":
          return NextResponse.json(await removeTopicEntry(agentId, slug, idOrText));
        default:
          return NextResponse.json(
            { success: false, error: `Unknown topic action "${action}". Use add, replace, remove, or create.` },
            { status: 400 },
          );
      }
    }

    return NextResponse.json({ success: false, error: "Provide action:'setPreferences' or target:'topic'." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 400 });
  }
}

// DELETE ?agent=<id>&topic=<slug>[&id=<entry-id>]
//   with id  -> remove one topic entry
//   without  -> delete the whole topic file
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const agentId = agentOf(req);
  const slug = (url.searchParams.get("topic") ?? "").trim();
  if (!slug) return NextResponse.json({ success: false, error: "topic query param required" }, { status: 400 });
  const id = (url.searchParams.get("id") ?? "").trim();
  try {
    if (id) return NextResponse.json(await removeTopicEntry(agentId, slug, id));
    return NextResponse.json(await deleteTopic(agentId, slug));
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 400 });
  }
}
