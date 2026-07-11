import { NextRequest, NextResponse } from "next/server";
import { generateTitle } from "@/lib/agent/title";
import { hasCredentials } from "@/lib/agent/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Background title generation for new conversations. Runs as a separate,
// stateless LLM call so the prompt/response never enters the user-visible chat
// history. (v2 conversations also generate titles via a run hook — see
// src/lib/assistant/title-hook.ts — so this route stays for the legacy client.)
export async function POST(req: NextRequest) {
  let userMessage = "";
  let assistantMessage = "";
  try {
    const body = await req.json();
    userMessage = typeof body?.userMessage === "string" ? body.userMessage : "";
    assistantMessage = typeof body?.assistantMessage === "string" ? body.assistantMessage : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!userMessage.trim()) {
    return NextResponse.json({ error: "userMessage is required" }, { status: 400 });
  }
  if (!(await hasCredentials())) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
  }
  try {
    const title = await generateTitle(userMessage, assistantMessage);
    if (!title) return NextResponse.json({ error: "Empty title" }, { status: 502 });
    return NextResponse.json({ title });
  } catch (err) {
    return NextResponse.json({ error: `Title generation failed: ${(err as Error).message}` }, { status: 502 });
  }
}
