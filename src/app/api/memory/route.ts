import { NextRequest, NextResponse } from "next/server";
import { listEntries, removeEntry, type MemoryTarget } from "@/lib/agent/memory/curated";
import { memoryTool } from "@/lib/agent/memory/tool";

export const dynamic = "force-dynamic";

function asTarget(t: string | null): MemoryTarget | null {
  return t === "user" || t === "memory" ? t : null;
}

// GET            -> { user: string[], memory: string[] }  (both curated surfaces)
// GET ?target=X  -> { target, entries }
export async function GET(req: NextRequest) {
  const t = asTarget(new URL(req.url).searchParams.get("target"));
  if (t) return NextResponse.json({ target: t, entries: await listEntries(t) });
  const [user, memory] = await Promise.all([listEntries("user"), listEntries("memory")]);
  return NextResponse.json({ user, memory });
}

// POST body: { target, action?, content?, oldText?, operations? } -> memory tool result
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const result = await memoryTool({
      action: body.action,
      target: body.target ?? "memory",
      content: body.content,
      oldText: body.oldText ?? body.old_text,
      operations: body.operations,
    });
    return new NextResponse(result, { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 400 });
  }
}

// DELETE ?target=X&text=<substring> -> remove the matching entry
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const t = asTarget(url.searchParams.get("target")) ?? "memory";
  const text = url.searchParams.get("text") ?? "";
  if (!text) return NextResponse.json({ success: false, error: "text query param required" }, { status: 400 });
  return NextResponse.json(await removeEntry(t, text));
}
