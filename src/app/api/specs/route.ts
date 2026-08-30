import { NextRequest, NextResponse } from "next/server";
import * as specfs from "@/lib/dev/spec-fs";
import { listSpecifications, getSpecification, specTree, parseTasks } from "@/lib/specs/pipeline";

export const dynamic = "force-dynamic";

// Paths are STORE-PREFIXED (`<storeId>/<rel>`), 018-external-spec-store.
// GET /api/specs                              -> { tree, specs }  (groups per store, incl. draft-branch nodes)
// GET /api/specs?id=<store/feature>           -> { spec }
// GET /api/specs?path=<store/rel>[&branch=]   -> { path, content, tasks?, branch? }
//                                                `branch` reads a bos/* draft branch (read-only, no checkout; 020)
// GET /api/specs?path=<store/rel>&liveBranch= -> { path, content }  reads through the SAME branch's
//                                                live, writable worktree (mounted via the Supervisor) —
//                                                what Build Studio's editor uses while a real feature
//                                                branch is selected for a directory-scanned store
// PUT /api/specs { path, content, branch? }   -> { path }         (write; `branch` targets that
//                                                live worktree; refused for read-only stores or with
//                                                no branch, per store — see dev/spec-fs.ts prepareWrite)
// DELETE /api/specs?path=<store/rel>[&branch=]-> { ok }           (delete; same gating as a write)
// PATCH /api/specs { path, to, branch? }      -> { path }         (rename/move; same gating as a write)
// Spec promotion is branch-coupled to the code promote (020) — no POST actions.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const id = url.searchParams.get("id");
  const branch = url.searchParams.get("branch");
  const liveBranch = url.searchParams.get("liveBranch");
  try {
    if (path) {
      // `liveBranch` reads through the branch's real, writable worktree
      // (Build Studio editing on a real feature branch) — distinct from the
      // read-only `branch` param below, which reads a `bos/*` draft branch
      // via `git show` with no checkout (020) and must never be confused
      // with a live, editable mount.
      const content = liveBranch
        ? await specfs.readFile(path, { branch: liveBranch })
        : branch
          ? await specfs.readFileAt(path, branch)
          : await specfs.readFile(path);
      const tasks = path.endsWith("tasks.md") ? parseTasks(content) : undefined;
      return NextResponse.json({ path, content, tasks, ...(branch ? { branch } : {}) });
    }
    if (id) {
      return NextResponse.json({ spec: await getSpecification(id) });
    }
    // `branch` makes the ITEM-store part of the tree read from that branch's
    // coupled user-apps worktree — the same place its writes go. Without it the
    // sidebar showed base's stale copy of every item artifact.
    const treeBranch = url.searchParams.get("branch") || undefined;
    const [tree, specs] = await Promise.all([specTree(treeBranch), listSpecifications(treeBranch)]);
    return NextResponse.json({ tree, specs });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const path = String(body.path ?? "");
    if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
    // When the caller has an active feature branch, the write targets that branch's
    // worktree spec store (020) so it lands on the same branch as the code.
    const branch = typeof body.branch === "string" && body.branch ? body.branch : undefined;
    const written = await specfs.writeFile(path, String(body.content ?? ""), branch ? { branch } : undefined);
    return NextResponse.json({ path: written });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  try {
    const branch = url.searchParams.get("branch") || undefined;
    await specfs.remove(path, branch ? { branch } : undefined);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const path = String(body.path ?? "");
    const to = String(body.to ?? "");
    if (!path || !to) return NextResponse.json({ error: "path and to are required" }, { status: 400 });
    const branch = typeof body.branch === "string" && body.branch ? body.branch : undefined;
    const renamed = await specfs.rename(path, to, branch ? { branch } : undefined);
    return NextResponse.json({ path: renamed });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
