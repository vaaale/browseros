import { NextRequest, NextResponse } from "next/server";
import { listFeatureBranches, createFeatureBranch } from "@/lib/system/git";
import { normalizeFeatureBranch } from "@/lib/agent/feature-branch";
import { listDeclaredFeatureBranches } from "@/lib/agent/conversations-server";

export const dynamic = "force-dynamic";

// Feature branches that Assistant conversations target for developer harness
// work. Under the Supervisor, the git worktree is provisioned by the Supervisor
// itself at delegate time — so a branch a conversation just "activated" via
// dev_branch_request has NO real git ref yet, only a name recorded on that one
// conversation's own file, until dev_delegate actually runs under it. Merge
// those declared-but-not-yet-real names in too, so a DIFFERENT conversation
// can select the same branch immediately instead of waiting for it to
// materialize — see listDeclaredFeatureBranches's own doc comment.
async function allKnownFeatureBranches(): Promise<string[]> {
  const [real, declared] = await Promise.all([listFeatureBranches(), listDeclaredFeatureBranches()]);
  return Array.from(new Set([...real, ...declared])).sort();
}

export async function GET() {
  return NextResponse.json({ featureBranches: await allKnownFeatureBranches() });
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
  const featureBranches = await allKnownFeatureBranches();
  return NextResponse.json({ ok: true, branch, featureBranches });
}
