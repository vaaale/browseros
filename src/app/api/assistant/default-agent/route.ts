import { NextRequest, NextResponse } from "next/server";
import { getDefaultPromptAgent, setDefaultPromptAgent } from "@/lib/agent/subagents/store";

export const dynamic = "force-dynamic";

// Shared default prompt template edited from Settings → Agents → Default Agent.
// Not exposed via /api/assistant/agent because it isn't a runnable agent — its
// body is prepended to any agent whose useDefaultPrompt is true.
export async function GET() {
  const agent = await getDefaultPromptAgent();
  return NextResponse.json({
    agent: {
      id: agent?.id ?? "default_agent",
      name: agent?.name ?? "Default",
      description: agent?.description ?? "",
      systemPrompt: agent?.systemPrompt ?? "",
    },
  });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const patch: { systemPrompt?: string; description?: string } = {};
    if (typeof body.body === "string") patch.systemPrompt = body.body;
    if (typeof body.description === "string") patch.description = body.description;
    if (patch.systemPrompt === undefined && patch.description === undefined) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }
    const existing = await getDefaultPromptAgent();
    await setDefaultPromptAgent({
      systemPrompt: patch.systemPrompt ?? existing?.systemPrompt ?? "",
      description: patch.description,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
