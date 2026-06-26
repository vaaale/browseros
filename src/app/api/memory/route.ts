import { NextRequest, NextResponse } from "next/server";
import { listMemories, addMemory, removeMemory, recall } from "@/lib/agent/memory/store";
import type { MemoryType } from "@/lib/agent/memory/types";

export const dynamic = "force-dynamic";

const TYPES: MemoryType[] = ["lesson", "fact", "preference", "procedure"];

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get("q");
  if (q) return NextResponse.json({ memories: await recall(q, 8) });
  return NextResponse.json({ memories: await listMemories() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.content) return NextResponse.json({ error: "content is required" }, { status: 400 });
    const type: MemoryType = TYPES.includes(body.type) ? body.type : "lesson";
    const memory = await addMemory({
      type,
      content: String(body.content),
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
    });
    return NextResponse.json({ memory });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  return NextResponse.json({ memories: await removeMemory(id) });
}
