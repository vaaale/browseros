import { NextRequest, NextResponse } from "next/server";
import {
  hasClaudeCreds,
  hasOpenCodeAuth,
  writeClaudeCreds,
  writeOpenCodeAuth,
  clearClaudeCreds,
  clearOpenCodeAuth,
} from "@/lib/devharness/harness-config";

export const dynamic = "force-dynamic";

// Status of the harness credential material. Never returns the raw content —
// only whether each credential is currently set (write-only field semantics).
export async function GET() {
  return NextResponse.json({
    claudeSet: hasClaudeCreds(),
    openCodeSet: hasOpenCodeAuth(),
  });
}

// Set or clear the Claude Code / OpenCode credential material. The content is
// written into the dedicated harness HOME with owner-only permissions and is
// never echoed back or logged.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      claude?: string;
      openCode?: string;
      clearClaude?: boolean;
      clearOpenCode?: boolean;
    };

    if (body.clearClaude) clearClaudeCreds();
    else if (typeof body.claude === "string" && body.claude.trim()) writeClaudeCreds(body.claude.trim());

    if (body.clearOpenCode) clearOpenCodeAuth();
    else if (typeof body.openCode === "string" && body.openCode.trim()) writeOpenCodeAuth(body.openCode.trim());

    return NextResponse.json({ ok: true, claudeSet: hasClaudeCreds(), openCodeSet: hasOpenCodeAuth() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
