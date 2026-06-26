import { NextRequest, NextResponse } from "next/server";
import { getSubAgent } from "@/lib/agent/subagents/store";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import { recordDelegation } from "@/lib/agent/memory/reflect";
import type { SubAgent } from "@/lib/agent/subagents/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const task = String(body.task ?? "");
    if (!task) return NextResponse.json({ error: "task is required" }, { status: 400 });

    let def: SubAgent | undefined;
    if (body.ephemeral && body.ephemeral.name && body.ephemeral.systemPrompt) {
      // Create-and-run an ephemeral agent that is not persisted to disk.
      const e = body.ephemeral;
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
      def = await getSubAgent(String(body.agent));
    }

    if (!def) return NextResponse.json({ error: `No sub-agent "${body.agent}" and no ephemeral spec provided` }, { status: 404 });

    const result = await runSubAgent(def, task);
    void recordDelegation(result).catch(() => {});
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
