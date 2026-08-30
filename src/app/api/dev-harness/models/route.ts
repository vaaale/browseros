import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { harnessCredentialEnv } from "@/lib/devharness/harness-config";
import { getSourceRepoRoot } from "@/lib/gitops/filesystems";
import CLAUDE_MODELS from "@/lib/devharness/claude-models.json";

// Model lists for the Dev Harness settings tab's model autocomplete.
//
// Claude Code has no API to list available models without an Anthropic API
// key (which the harness doesn't require — it authenticates via its own
// credential file, e.g. a Claude subscription login), so the Claude list is a
// maintained static file instead of a live query.
//
// OpenCode IS queryable — `opencode models` prints every model its configured
// providers expose, one per line as "<provider>/<model>".

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const execFileAsync = promisify(execFile);
const OPENCODE_TIMEOUT_MS = 10_000;

function claudeModels(): string[] {
  return (CLAUDE_MODELS as unknown[]).filter((m): m is string => typeof m === "string");
}

async function openCodeModels(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("opencode", ["models"], {
      // Not a bare process.cwd() — see getHarnessConfig's cwd comment: the
      // server process serving this request may be running from a detached
      // preview worktree that no longer exists.
      cwd: await getSourceRepoRoot(),
      env: { ...process.env, ...harnessCredentialEnv() },
      timeout: OPENCODE_TIMEOUT_MS,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("OpenCode CLI not found on PATH.");
    }
    throw err;
  }
}

export async function GET(req: NextRequest) {
  const transport = new URL(req.url).searchParams.get("transport");
  try {
    const models = transport === "opencode" ? await openCodeModels() : claudeModels();
    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json({ models: [], error: (err as Error).message || "Failed to list models" });
  }
}
