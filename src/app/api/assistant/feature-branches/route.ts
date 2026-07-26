import { NextRequest, NextResponse } from "next/server";
import { listFeatureBranches, createFeatureBranch } from "@/lib/system/git";
import { normalizeFeatureBranch } from "@/lib/agent/feature-branch";

export const dynamic = "force-dynamic";

// Feature branches that Assistant conversations target for developer harness
// work. Under the Supervisor, the git worktree is provisioned by the Supervisor
// itself at delegate time. In standalone dev mode, the branch is created here.

export async function GET() {
  return NextResponse.json({ featureBranches: await listFeatureBranches() });
}

export async function POST(req: NextRequest) {
  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  const branch = normalizeFeatureBranch(name);
  if (!branch) {
    return NextResponse.json(
      { ok: false, error: `Invalid branch name "${name}": use a lowercase kebab name like "my-change" (1-4 words).` },
      { status: 400 },
    );
  }
  try {
    // Under the Supervisor this throws (worktree provisioned at delegate time);
    // in standalone dev mode it creates or checks out the branch.
    await createFeatureBranch(branch);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Suppress the expected "Supervisor owns git" guard — the Supervisor handles
    // branch creation itself, so from the UI's perspective this is still success.
    if (!msg.includes("Supervisor")) {
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
  }
  const featureBranches = await listFeatureBranches();
  return NextResponse.json({ ok: true, branch, featureBranches });
}
