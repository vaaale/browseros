import { NextRequest, NextResponse } from "next/server";
import { status, createFeatureBranch, stageFiles } from "@/lib/system/git";
import { supervisorNextChanges } from "@/lib/devharness/supervisor";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // The main checkout's branch + working-tree changes. Under the Supervisor, a
    // self-modification candidate's edits are COMMITTED in an isolated worktree, so
    // this looks clean even when an agent just changed something — `candidate`
    // surfaces that so the assistant doesn't conclude "nothing changed".
    const base = await status();
    const sup = await supervisorNextChanges().catch(() => null);
    const candidate = sup && sup.ok && sup.candidate ? sup.candidate : null;
    return NextResponse.json({ ...base, candidate });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Under the Supervisor the live checkout IS the running base; branching/staging
    // it would break the running version and block promote. The Supervisor owns
    // version branches and the developer sub-agent edits an isolated preview
    // worktree, so these in-place ops are refused here (specs/005, 017 diagnosis).
    if ((process.env.BOS_SUPERVISOR_URL || "").trim()) {
      return NextResponse.json(
        {
          error:
            "Branching/staging the main checkout is disabled under the Supervisor. " +
            "Delegate source changes to the developer sub-agent — they are made on an " +
            "isolated preview worktree, then previewed/promoted from the top bar.",
        },
        { status: 409 },
      );
    }
    const body = await req.json();
    if (body.op === "branch") {
      if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
      return NextResponse.json({ branch: await createFeatureBranch(String(body.name)) });
    }
    if (body.op === "stage") {
      const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
      return NextResponse.json({ staged: await stageFiles(paths) });
    }
    return NextResponse.json({ error: `Unknown op: ${body.op}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
