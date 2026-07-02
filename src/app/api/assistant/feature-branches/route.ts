import { NextRequest, NextResponse } from "next/server";
import { listFeatureBranches } from "@/lib/system/git";
import { normalizeFeatureBranch } from "@/lib/agent/feature-branch";

export const dynamic = "force-dynamic";

// Feature branches that Assistant conversations target for developer harness
// work. A branch is just a `bos/<kebab-name>` NAME anchored to the conversation;
// the actual git worktree is provisioned (or resumed) by the Supervisor at
// delegate time, so creating a branch here only validates + normalizes the name.

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
  const existing = await listFeatureBranches();
  const featureBranches = existing.includes(branch) ? existing : [branch, ...existing];
  return NextResponse.json({ ok: true, branch, featureBranches });
}
