import { NextRequest, NextResponse } from "next/server";
import { getConversationActiveFeatureBranch, validateFeatureBranch } from "@/lib/agent/conversations-server";
import { getAgent } from "@/lib/agent/subagents/store";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import type { Agent } from "@/lib/agent/subagents/types";
import { withLogContext, logger } from "@/lib/logging";

export const dynamic = "force-dynamic";

// Streams the sub-agent run as NDJSON: one {type:"tool"} line per tool call as
// it happens, enriched {type:"tool_result"} / {type:"reasoning_delta"} /
// {type:"final_text"} lines (ADR-13, local headless runs only), then a final
// {type:"done", result, text} | {type:"error"} line (text = the agent's final
// response text). This lets the chat show the sub-agent's events live instead
// of all at once when it finishes, and lets a consuming service log the full
// agent-execution stream.
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
  const conversationId =
    typeof body.conversationId === "string"
      ? body.conversationId
      : typeof body.threadId === "string"
        ? body.threadId
        : undefined;
  let featureBranch: string | undefined;
  try {
    featureBranch =
      typeof body.featureBranch === "string"
        ? validateFeatureBranch(body.featureBranch)
        : await getConversationActiveFeatureBranch(conversationId);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  if (agent.type === "claude" && body.contentOnly !== true && !featureBranch) {
    return NextResponse.json(
      {
        error:
          "Developer harness requires an active feature branch. Call the requestFeatureBranch action to set one up (it prompts the user for a name), then retry the delegation.",
      },
      { status: 400 },
    );
  }

  // Correlate this delegation (and any Supervisor build it triggers) to the
  // originating browser session — see specs/017-central-logging.
  const sessionId = req.headers.get("x-bos-session") || undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const emit = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      return withLogContext({ sessionId }, async () => {
      try {
        logger().info("subagents.delegate", `delegate \u2192 ${agent.name}`, { agent: agent.id, interactive: body.interactive === true });
        const result = await runSubAgent(agent, task, {
          // ADR-13 (Workflow Manager service-tools): preserve the legacy
          // per-tool-call NDJSON line ({type:"tool", tool, input}) for backward
          // compat; forward the enriched events (tool_result / reasoning_delta /
          // final_text) verbatim — they carry their own `type` + fields, so a
          // consuming service can log the full agent-execution stream without
          // round-trip reconstruction.
          onEvent: (ev) => {
            if ("type" in ev) emit(ev);
            else emit({ type: "tool", tool: ev.tool, input: ev.input });
          },
          contentOnly: body.contentOnly === true,
          // Resolved server-side; not exposed in the assistant tool schema.
          featureBranch,
          interactive: body.interactive === true,
          // The sub-agent's tools resolve the active feature branch from this;
          // omitting it made every branch-gated spec write fail as if no
          // branch were set, even when the caller had one.
          conversationId,
        });
         // ADR-13: the terminal line also carries the agent's final response
         // text (result.output) as `text` — additive; existing consumers that
         // read only `result` are unaffected.
         emit({ type: "done", result, text: result.output });
        logger().info("subagents.delegate", `delegate done: ${agent.name}`, { steps: result.steps, ...(result.error ? { error: result.error } : {}) });
      } catch (err) {
        emit({ type: "error", error: (err as Error).message });
        logger().error("subagents.delegate", `delegate failed: ${agent.name}`, err);
      }
      await logger().flush();
      controller.close();
      });
    },
  });

  return new NextResponse(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
