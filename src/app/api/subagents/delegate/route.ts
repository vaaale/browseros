import { NextRequest, NextResponse } from "next/server";
import { getAgent } from "@/lib/agent/subagents/store";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import type { Agent } from "@/lib/agent/subagents/types";

export const dynamic = "force-dynamic";
// A local dev tool-loop can run many steps; the NDJSON stream keeps the
// connection alive, but give the route generous headroom.
export const maxDuration = 600;

// Streams the sub-agent run as NDJSON: one {type:"tool"} line per tool call as
// it happens, then a final {type:"done"|"error"} line. This lets the chat show
// the sub-agent's events live instead of all at once when it finishes.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const task = String(body.task ?? "");
  if (!task) return NextResponse.json({ error: "task is required" }, { status: 400 });

  let def: Agent | undefined;
  const e = body.ephemeral as Record<string, unknown> | undefined;
  if (e && e.name && e.systemPrompt) {
    def = {
      id: String(e.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ephemeral",
      name: String(e.name),
      description: String(e.description ?? ""),
      type: e.type === "claude" ? "claude" : "local",
      systemPrompt: String(e.systemPrompt),
      tools: Array.isArray(e.tools) ? e.tools.map(String) : undefined,
      subagentType: e.subagentType ? String(e.subagentType) : undefined,
      ephemeral: true,
    };
  } else if (body.agent) {
    def = await getAgent(String(body.agent));
  }

  if (!def) {
    return NextResponse.json({ error: `No sub-agent "${body.agent}" and no ephemeral spec provided` }, { status: 404 });
  }
  const agent = def;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await runSubAgent(agent, task, {
          onEvent: (ev) => emit({ type: "tool", ...ev }),
          contentOnly: body.contentOnly === true,
          // `branchKey` anchors repeated dev work to one feature branch; any caller
          // (chat, workflow, external integration) may supply an arbitrary stable id
          // (e.g. `gitlab-issue:1234`). `threadId` is the legacy alias the chat used.
          branchKey:
            typeof body.branchKey === "string"
              ? body.branchKey
              : typeof body.threadId === "string"
                ? body.threadId
                : undefined,
          // Interactive sessions let a live preview win over the key; omit/false for
          // headless callers so their key is authoritative (never adopts a stray preview).
          interactive: body.interactive === true,
        });
        emit({ type: "done", result });
      } catch (err) {
        emit({ type: "error", error: (err as Error).message });
      }
      controller.close();
    },
  });

  return new NextResponse(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
