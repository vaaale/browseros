import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { runBash, DEFAULT_TIMEOUT_MS } from "@/lib/system/bash";
import { getConfigValue } from "@/lib/config/registry";

// POST /api/system/bash — run a shell command via bash -lc.
// Gated by the "system-tools.enabled" config toggle (off by default).
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  try {
    const enabled = (await getConfigValue("system-tools", "enabled")) === true;
    if (!enabled) {
      return NextResponse.json(
        { error: "Bash tool is disabled. Enable it in Settings → System Tools." },
        { status: 403 },
      );
    }

    const body = (await req.json()) as {
      command?: unknown;
      cwd?: unknown;
      timeoutMs?: unknown;
    };
    const command = typeof body.command === "string" ? body.command : "";
    if (!command.trim()) {
      return NextResponse.json({ error: "command is required" }, { status: 400 });
    }
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined;
    const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : DEFAULT_TIMEOUT_MS;

    const result = await runBash(command, { cwd, timeoutMs });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
