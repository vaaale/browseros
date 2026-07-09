import { NextRequest, NextResponse } from "next/server";
import * as vfs from "@/os/vfs";
import { logger } from "@/lib/logging";
import { listEntries, removeEntry, type MemoryTarget } from "@/lib/agent/memory/curated";
import { memoryTool } from "@/lib/agent/memory/tool";
import {
  addTopicEntry,
  createTopic,
  getTopic,
  listTopicSlugs,
  removeTopicEntry,
  replaceTopicEntry,
  topicPath,
} from "@/lib/agent/memory/topics";

export const dynamic = "force-dynamic";

function asTarget(t: string | null): MemoryTarget | null {
  return t === "user" || t === "memory" ? t : null;
}

// GET            -> { user: string[], memory: string[], topics: string[] }
// GET ?target=X  -> { target, entries }
// GET ?topic=Y   -> { topic: slug, digest, entries: [{ id, text, timestamp }] }
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const topicSlug = url.searchParams.get("topic")?.trim();
  if (topicSlug) {
    const topic = await getTopic(topicSlug);
    if (!topic) return NextResponse.json({ error: `Topic "${topicSlug}" not found` }, { status: 404 });
    return NextResponse.json({
      topic: topic.slug,
      digest: topic.digest,
      entries: topic.entries.map((e) => ({ id: e.id, text: e.text, timestamp: e.timestamp })),
    });
  }
  const t = asTarget(url.searchParams.get("target"));
  if (t) return NextResponse.json({ target: t, entries: await listEntries(t) });
  const [user, memory, topics] = await Promise.all([
    listEntries("user"),
    listEntries("memory"),
    listTopicSlugs().catch(() => [] as string[]),
  ]);
  return NextResponse.json({ user, memory, topics });
}

// POST body:
//   Curated (user/memory): { target, action?, content?, oldText?, operations? }
//   Topic:                 { target: "topic", topic, action, content?, id? }
//                          action = "add" | "replace" | "remove" | "create"
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body?.target === "topic") {
      const slug = typeof body.topic === "string" ? body.topic.trim() : "";
      if (!slug) {
        return NextResponse.json({ success: false, error: "topic slug is required" }, { status: 400 });
      }
      const action = String(body.action ?? "");
      const content = typeof body.content === "string" ? body.content : "";
      const idOrText = typeof body.id === "string" || typeof body.id === "number"
        ? String(body.id)
        : typeof body.oldText === "string"
          ? body.oldText
          : "";
      switch (action) {
        case "create":
          logger().info("memory", "topic created", { slug });
          return NextResponse.json(await createTopic(slug, content));
        case "add":
          logger().info("memory", "topic entry added", { slug });
          return NextResponse.json(await addTopicEntry(slug, content));
        case "replace":
          logger().info("memory", "topic entry replaced", { slug });
          return NextResponse.json(await replaceTopicEntry(slug, idOrText, content));
        case "remove":
          logger().info("memory", "topic entry removed", { slug });
          return NextResponse.json(await removeTopicEntry(slug, idOrText));
        default:
          return NextResponse.json(
            { success: false, error: `Unknown topic action "${action}". Use add, replace, remove, or create.` },
            { status: 400 },
          );
      }
    }
    const result = await memoryTool({
      action: body.action,
      target: body.target ?? "memory",
      content: body.content,
      oldText: body.oldText ?? body.old_text,
      operations: body.operations,
    });
    return new NextResponse(result, { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    logger().error("memory", "memory write failed", err);
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 400 });
  }
}

// DELETE
//   ?target=user|memory&text=<substring>          → remove curated entry
//   ?target=topic&topic=<slug>&id=<entry-id>      → remove one topic entry
//   ?target=topic&topic=<slug>                    → delete the entire topic file
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const rawTarget = url.searchParams.get("target");
  if (rawTarget === "topic") {
    const slug = (url.searchParams.get("topic") ?? "").trim();
    if (!slug) return NextResponse.json({ success: false, error: "topic query param required" }, { status: 400 });
    const id = (url.searchParams.get("id") ?? "").trim();
    if (id) {
      logger().info("memory", "topic entry removed", { slug, id });
      return NextResponse.json(await removeTopicEntry(slug, id));
    }
    // No id → delete the whole topic file.
    try {
      await vfs.remove(topicPath(slug));
      logger().info("memory", "topic deleted", { slug });
      return NextResponse.json({ success: true, message: `Topic "${slug}" deleted.` });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return NextResponse.json({ success: false, error: `Topic "${slug}" not found.` }, { status: 404 });
      }
      return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
    }
  }
  const t = asTarget(rawTarget) ?? "memory";
  const text = url.searchParams.get("text") ?? "";
  if (!text) return NextResponse.json({ success: false, error: "text query param required" }, { status: 400 });
  logger().info("memory", "curated entry removed", { target: t });
  return NextResponse.json(await removeEntry(t, text));
}
