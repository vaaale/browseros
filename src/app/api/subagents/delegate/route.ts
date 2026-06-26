import { NextRequest, NextResponse } from "next/server";
import { getSubAgent } from "@/lib/agent/subagents/store";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import { recordDelegation } from "@/lib/agent/memory/reflect";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { agent, task } = await req.json();
    if (!agent || !task) return NextResponse.json({ error: "agent and task are required" }, { status: 400 });

    const def = await getSubAgent(String(agent));
    if (!def) return NextResponse.json({ error: `No sub-agent named "${agent}"` }, { status: 404 });

    const result = await runSubAgent(def, String(task));
    // Grow the self-improving memory from this outcome (best-effort).
    void recordDelegation(result).catch(() => {});
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
