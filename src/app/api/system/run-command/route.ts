import { NextRequest, NextResponse } from "next/server";
import { runCommand, type RunLanguage } from "@/lib/system/run-command";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const LANGS: RunLanguage[] = ["bash", "python", "node"];

// Main-chat surface for run_command: the client sends the browser-session id
// (cookie) + the active agent id so the executor keys the sandbox container on
// (session, agent). Sub-agents call the executor directly (see runner.ts).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const command = typeof body.command === "string" ? body.command : "";
    if (!command.trim()) return NextResponse.json({ error: "command is required" }, { status: 400 });
    const language: RunLanguage = LANGS.includes(body.language) ? body.language : "bash";
    const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "default";
    const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : "main";
    const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
    const result = await runCommand({ command, language, timeoutMs, sessionKey: `${sessionId}:${agentId}` });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
