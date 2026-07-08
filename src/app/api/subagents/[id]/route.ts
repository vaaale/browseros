import { NextRequest, NextResponse } from "next/server";
import {
  deleteSubAgent,
  getAgent,
  listSubAgents,
  ProtectedAgentError,
  setAgentMeta,
} from "@/lib/agent/subagents/store";

export const dynamic = "force-dynamic";

// PATCH /api/subagents/:id — update AGENT.md frontmatter (name/description) only.
// Prompt & capability edits go through /api/assistant/agent (PATCH body/agentId).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { name?: unknown; description?: unknown };
    const meta: { name?: string; description?: string } = {};
    if (typeof body.name === "string") meta.name = body.name;
    if (typeof body.description === "string") meta.description = body.description;
    if (meta.name === undefined && meta.description === undefined) {
      return NextResponse.json({ error: "name or description required" }, { status: 400 });
    }
    const agent = await getAgent(id);
    if (!agent) return NextResponse.json({ error: `agent not found: ${id}` }, { status: 404 });
    const updated = await setAgentMeta(agent.id, meta);
    return NextResponse.json({ subAgent: updated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await deleteSubAgent(id);
    return NextResponse.json({ subAgents: await listSubAgents() });
  } catch (err) {
    if (err instanceof ProtectedAgentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
