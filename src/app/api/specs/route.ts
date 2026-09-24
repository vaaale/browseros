import { NextRequest, NextResponse } from "next/server";
import * as specfs from "@/lib/dev/spec-fs";
import { listSpecifications, getSpecification, specTree, parseTasks, activeMethodSummary } from "@/lib/specs/pipeline";

export const dynamic = "force-dynamic";

/** One refusal shape for every verb on this route.
 *
 *  `error` stays verbatim — each refusal names WHY, and paraphrasing loses the
 *  part that tells the caller what to do instead. `code` rides alongside when
 *  the failure has one, so a UI can recognise a known case (a write with no
 *  feature branch) and render text aimed at a person, rather than showing them
 *  the agent-facing recovery instructions the message carries. */
function refuse(err: unknown) {
  const code = (err as { code?: unknown })?.code;
  return NextResponse.json(
    { error: (err as Error).message, ...(typeof code === "string" ? { code } : {}) },
    { status: 400 },
  );
}

// Paths are STORE-PREFIXED (`<storeId>/<rel>`), 018-external-spec-store.
// GET /api/specs                              -> { tree, specs, method }  (groups per store, incl. draft-branch nodes;
//                                                `method` is the active descriptor summary — 045 FR-014, so the
//                                                client renders phases it did not compute and holds no phase vocabulary)
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
    const [tree, specs, method] = await Promise.all([specTree(treeBranch), listSpecifications(treeBranch), activeMethodSummary()]);
    return NextResponse.json({ tree, specs, method });
  } catch (err) {
    return refuse(err);
  }
}

// POST /api/specs { op: "preflight-method" | "set-method", store, method, project?, branch? }
//   045 FR-009/FR-010. GET alone is not enough — assigning a method WRITES
//   spec-store.json (or, with `project`, that Project's project.json), on the
//   active bos/* branch, riding the normal promote. FR-008's chain is
//   project > store > global, and the resolver honoured all three from the
//   start — but only the STORE level was reachable, so the finest-grained
//   binding existed and could not be set. `project` closes that.
//   "preflight-method" is the dry run the confirm step shows; "set-method"
//   re-runs the SAME check before writing, so a stale preview cannot be
//   confirmed into an orphaning change.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const op = String(body.op ?? "");
    const storeId = String(body.store ?? "");
    const methodId = String(body.method ?? "");
    const projectId = typeof body.project === "string" && body.project.trim() ? body.project.trim() : undefined;
    if (!op || !storeId) return NextResponse.json({ error: "op and store are required" }, { status: 400 });

    // The SAME resolution the lifecycle ops use, marketplace included. This was
    // its own `listStores()` lookup, which never yields the synthesised
    // marketplace store — so "New app" on the User Apps heading was refused here
    // with `Unknown spec store "user-apps"` before ever reaching the code that
    // synthesises it.
    // Read here, not only inside the project-op block below: the branch is what
    // makes an app created ON it resolvable at all.
    const opBranch = typeof body.branch === "string" && body.branch ? body.branch : undefined;
    const { resolveOpStore } = await import("@/lib/specs/lifecycle");
    const store = await resolveOpStore(storeId, opBranch);
    if (!store) return NextResponse.json({ error: `Unknown spec store "${storeId}".` }, { status: 400 });
    // bos-system-specs is permanently spec-kit and unconditionally read-only.
    if (!store.writable) return NextResponse.json({ error: `Store "${storeId}" is read-only.` }, { status: 400 });

    // 049 — project lifecycle. The SAME implementation the agent tools call
    // (FR-010): two paths to one outcome is the shape every divergence in this
    // subsystem has taken, and the UI is where it would be found last.
    if (op === "create-project" || op === "rename-project" || op === "delete-project" || op === "describe-project-deletion") {
      const lc = await import("@/lib/specs/lifecycle");
      const branch = opBranch;
      const name = typeof body.name === "string" ? body.name : "";
      const projectId = typeof body.project === "string" ? body.project : "";
      const workflow = typeof body.workflow === "string" && body.workflow.trim() ? body.workflow.trim() : undefined;

      if (op === "create-project") {
        return NextResponse.json({ project: await lc.createProjectIn(storeId, name, { branch, workflow }) });
      }
      if (op === "rename-project") {
        return NextResponse.json({ project: await lc.renameProjectIn(storeId, projectId, name, { branch }) });
      }
      if (op === "describe-project-deletion") {
        return NextResponse.json({ deletion: await lc.describeProjectDeletion(storeId, projectId) });
      }
      // FR-006: the confirmation is the CALLER's, but the server still refuses
      // an unconfirmed delete — a destructive op reachable by one unguarded
      // POST is not protected by a dialog that lives somewhere else.
      if (body.confirm !== true) {
        const d = await lc.describeProjectDeletion(storeId, projectId);
        return NextResponse.json(
          { error: `Deleting "${d.label}" removes ${d.units} unit(s). Re-send with confirm: true.`, deletion: d },
          { status: 409 },
        );
      }
      await lc.deleteProjectIn(storeId, projectId, { branch });
      return NextResponse.json({ ok: true });
    }

    const { getMethod } = await import("@/lib/specs/method/registry");
    const to = getMethod(methodId);
    if (!to) return NextResponse.json({ error: `Method "${methodId}" is not installed.` }, { status: 400 });

    // Validate the Project BEFORE resolving anything: binding a typo'd id would
    // otherwise write a project.json into a directory that is not a Project,
    // which nothing reads and nothing reports.
    const { getProject } = await import("@/lib/specs/projects");
    const project = projectId ? await getProject(storeId, projectId) : undefined;
    if (projectId && !project) {
      return NextResponse.json({ error: `Store "${storeId}" has no Project "${projectId}".` }, { status: 400 });
    }

    // Resolve `from` through the SAME chain the pipeline uses, global default
    // included. Omitting it reported the change as "spec-kit -> x" whenever the
    // user's default was something else, so the preview named a starting point
    // the store was never at.
    // THE entry point — the chain is assembled in exactly one place. This used
    // to rebuild it here and got it wrong twice: first omitting the global
    // default, then never reading `workflow`.
    const { methodForStore } = await import("@/lib/specs/pipeline");
    const from = await methodForStore(storeId, projectId);

    const { preflightMethodChange, describePreflight } = await import("@/lib/specs/method/preflight");
    const report = await preflightMethodChange(storeId, from, to, projectId);

    if (op === "preflight-method") {
      // A constitution belongs to a STORE. Reconciling one for a per-Project
      // binding would move the whole store's principles because a single
      // Project changed method — so project scope reports on the Project and
      // leaves the constitution alone.
      const constitution = projectId
        ? undefined
        : await (async () => {
            const { reconcileConstitution, describeConstitutionOutcome } = await import("@/lib/specs/method/constitution");
            const outcome = await reconcileConstitution(storeId, from, to, {
              isSystemStore: store.owner === "system",
              apply: false,
            });
            return describeConstitutionOutcome(outcome, to);
          })();
      return NextResponse.json({ report, summary: describePreflight(report), constitution });
    }

    if (op === "set-method") {
      // Preflight is the GATE, not a label beside an already-enabled button.
      if (report.wouldOrphan && body.force !== true) {
        return NextResponse.json({ error: describePreflight(report), report }, { status: 409 });
      }
      const branch = typeof body.branch === "string" && body.branch ? body.branch : undefined;
      // Project scope writes the Project's own manifest; store scope writes the
      // store's. Item stores have no manifest on disk at all — writing one here
      // is what CREATES it, which is why item-stores.ts reads the file rather
      // than requiring it.
      const manifestPath = projectId ? `${storeId}/${projectId}/project.json` : `${storeId}/spec-store.json`;
      const raw = await specfs.readFile(manifestPath).catch(() => "{}");
      // MERGE. Rewriting the manifest from known fields would drop whatever a
      // store legitimately carries that this route does not model.
      const manifest = { ...(JSON.parse(raw) as Record<string, unknown>), method: methodId };
      await specfs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", branch ? { branch } : undefined);

      if (projectId) {
        return NextResponse.json({ store: storeId, project: projectId, method: methodId });
      }
      const { reconcileConstitution, describeConstitutionOutcome } = await import("@/lib/specs/method/constitution");
      const outcome = await reconcileConstitution(storeId, from, to, {
        isSystemStore: store.owner === "system",
        branch,
        apply: true,
      });
      return NextResponse.json({ store: storeId, method: methodId, constitution: describeConstitutionOutcome(outcome, to) });
    }

    return NextResponse.json({ error: `Unknown op "${op}".` }, { status: 400 });
  } catch (err) {
    return refuse(err);
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
    // 047 FR-009: frozen sections are read-only to a user edit.
    const { assertEditablePath } = await import("@/lib/specs/pipeline");
    await assertEditablePath(path);
    const written = await specfs.writeFile(path, String(body.content ?? ""), branch ? { branch } : undefined);
    return NextResponse.json({ path: written });
  } catch (err) {
    return refuse(err);
  }
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  try {
    const branch = url.searchParams.get("branch") || undefined;
    const { assertEditablePath } = await import("@/lib/specs/pipeline");
    await assertEditablePath(path);
    await specfs.remove(path, branch ? { branch } : undefined);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return refuse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const path = String(body.path ?? "");
    const to = String(body.to ?? "");
    if (!path || !to) return NextResponse.json({ error: "path and to are required" }, { status: 400 });
    const branch = typeof body.branch === "string" && body.branch ? body.branch : undefined;
    // BOTH ends: renaming INTO an archive is un-reviewed archiving, and renaming
    // OUT of one is un-archiving. Each is a semantic operation this feature
    // defers, not a file move.
    const { assertEditablePath } = await import("@/lib/specs/pipeline");
    await assertEditablePath(path);
    await assertEditablePath(to);
    const renamed = await specfs.rename(path, to, branch ? { branch } : undefined);
    return NextResponse.json({ path: renamed });
  } catch (err) {
    return refuse(err);
  }
}
