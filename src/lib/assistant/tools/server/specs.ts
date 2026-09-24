import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, parallel, schema, p } from "./util";
import * as specfs from "@/lib/dev/spec-fs";
import { getStore } from "@/lib/specs/stores";
import { createItemSpec } from "@/lib/specs/create";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";
import type { ToolContext } from "../../tools";

// Marketplace-item spec tools (overrides 018/specify's original "always
// centralize in user-specs" convention for this one target type — a deliberate
// product decision). Scoped ONLY to item-owned stores (owner: "item",
// item-stores.ts): BOS-core/user specs are unaffected and keep using the
// file_* tools on /Specs/user-specs, /Specs/bos-system-specs exactly as
// before. Keeping this boundary crisp means no two tool families ever claim
// the same content.
//
// EVERY op — read AND write — runs against the conversation's active `bos/*`
// feature branch, exactly like /Specs and like BOS's own source. An item's
// content lives in `data/user-apps`, a branch-coupled repo, so its spec travels
// with the item's code and promotes or discards with it.
//
// Reads MUST use the same branch as writes. They briefly did not, and it
// produced a silent read/write desync in production: writes landed in the
// branch's clone while `app_spec_read`/`app_spec_list` kept reporting base's
// copy, so the agent could not see its own writes. It concluded the writes were
// failing, re-issued them, and burned a long loop "diagnosing" a phantom bug —
// and any find/replace it derived from the stale text was being matched against
// a different file than the one it had read.
//
// The former exemption here ("no active feature-branch requirement") existed
// only because item stores had no branch mechanism; they now use the same one
// as everything else.

/** The branch every item-spec op runs against: the conversation's active
 *  feature branch. Absent on a WRITE → spec-fs's own gate (prepareWrite)
 *  refuses it and the message tells the model to call dev_branch_request, so the
 *  elicitation is identical to the one BOS-core spec and source edits trigger.
 *  Absent on a READ → the live content, which is correct: with no branch active
 *  there is nothing else to read. */
async function specCtx(ctx: ToolContext): Promise<specfs.SpecCtx | undefined> {
  const branch = await getConversationActiveFeatureBranch(ctx.conversationId).catch(() => undefined);
  return branch ? { branch } : undefined;
}

async function requireItemStore(path: string, toolName: string, branch?: string): Promise<void> {
  const [storeId] = path.split("/");
  // Base first, then the branch — an app the agent just CREATED exists only in
  // that branch's clone, so a base-only lookup refused every follow-up write to
  // the app it had itself just made, with "Unknown spec store". Same order and
  // same reason as spec-fs's resolveInStore: the branch lookup costs a
  // Supervisor round trip, so only the case that needs it pays.
  const store = (await getStore(storeId)) ?? (branch ? await getStore(storeId, branch) : undefined);
  if (!store) throw new Error(`Unknown spec store "${storeId}".`);
  if (store.owner !== "item") {
    throw new Error(
      `${toolName} only operates on marketplace-item specs (item-<id>/...). ` +
        `For BOS-core/user specs, use file_read/file_write/file_edit/file_patch on /Specs/... instead.`,
    );
  }
}

/** 049 — project lifecycle (FR-001). Thin wrappers over lifecycle.ts, which is
 *  also what the Build Studio context menus call. */
export function projectLifecycleTools(): Record<string, AssistantTool> {
  return {
    /** 051 FR-022 — the agent's half of instruction editing. The SAME functions
     *  the inspector's route calls; there is no second implementation, because
     *  every divergence in this subsystem has come from two paths to one
     *  outcome (FR-019). */
    methods_fork_status: parallel(
      serverTool(
        "methods_fork_status",
        "For a workflow the user forked: what it came from, whether that source has released a newer version since, and exactly which phases the user added or removed. Call this before offering to upgrade a fork — it is what tells you WHAT to re-apply onto the new base.",
        schema({ workflow: p.str("A forked workflow's id") }, ["workflow"]),
        async ({ workflow }) => {
          const { forkStatus } = await import("@/lib/specs/method/user-workflows");
          const st = await forkStatus(String(workflow));
          if (!st) return `"${workflow}" is not one of the user's forks — it comes from a pack, so there is nothing to upgrade.`;
          const lines = [
            `${st.id}: forked from ${st.from} @ ${st.fromVersion}`,
            st.currentVersion === null
              ? `  ${st.from} is NOT INSTALLED — the fork still works, but there is no newer base to re-fork from.`
              : st.behind
                ? `  ${st.from} is now @ ${st.currentVersion} — a newer base exists.`
                : `  ${st.from} is still @ ${st.currentVersion} — nothing to upgrade to.`,
            `  the user ADDED phases:   ${st.changedPhases.added.join(", ") || "none"}`,
            `  the user REMOVED phases: ${st.changedPhases.removed.join(", ") || "none"}`,
          ];
          if (st.behind) {
            lines.push(
              `  To upgrade: fork ${st.from} again under a new id, then re-apply the changes above.`,
              `  Re-apply them with JUDGEMENT — if ${st.from} renamed or restructured a phase the user had changed,`,
              `  say so rather than mapping it silently. Never merge blindly.`,
            );
          }
          return lines.join("\n");
        },
      ),
    ),

    methods_fork: parallel(
      serverTool(
        "methods_fork",
        "Fork a workflow into a NEW NAMED one the user owns, so it can be bound to some stores while others keep the original. Use this ONLY when a separate variant is wanted — to change a pack's own prompts everywhere it is used, edit them with methods_phase_instructions_set instead, which keeps receiving the pack's improvements.",
        schema(
          { source: p.str("Workflow id to fork, e.g. 'bmad'"), id: p.str("New id: lowercase letters, digits and dashes"), label: p.str("Human label (optional)") },
          ["source", "id"],
        ),
        async ({ source, id, label }) => {
          const { forkWorkflow, registerUserWorkflows } = await import("@/lib/specs/method/user-workflows");
          const wf = await forkWorkflow(String(source), String(id), label ? String(label) : undefined);
          const { failed } = await registerUserWorkflows();
          const why = failed[String(id)];
          if (why) return `Forked, but it did not register: ${why}`;
          if (wf.kind !== "fork") return "Forked.";
          return `Forked ${wf.from} @ ${wf.fromVersion} into "${id}". It is INDEPENDENT: upstream changes will not reach it. Bind a store to it to use it.`;
        },
      ),
    ),

    methods_phase_instructions: parallel(
      serverTool(
        "methods_phase_instructions",
        "Read the INSTRUCTIONS for one phase of a workflow — the prompt that says what to actually do for that step. Reports whether they came from the pack or from the user's own edit, and says so plainly when the pack ships none.",
        schema({ workflow: p.str("Workflow id, e.g. 'spec-kit'"), phase: p.str("Phase id, e.g. 'plan'") }, ["workflow", "phase"]),
        async ({ workflow, phase }) => {
          const { readPhaseInstructions } = await import("@/lib/specs/method/instructions");
          const i = await readPhaseInstructions(String(workflow), String(phase));
          if (i.source === "none") {
            return i.undeclared
              ? `"${phase}" has NO instructions — this pack declares none for it. Write some with methods_phase_instructions_set rather than inventing what the step does each time.`
              : `"${phase}" declares instructions at ${i.rel}, but no file is there.`;
          }
          return `source: ${i.source === "overlay" ? "the user's edit" : "the pack"}\n\n${i.text}`;
        },
      ),
    ),

    methods_phase_instructions_set: parallel(
      serverTool(
        "methods_phase_instructions_set",
        "Write the instructions for one phase of a workflow, or revert them to the pack's. The user's version is stored OUTSIDE the pack, so it survives the pack being updated or reinstalled — you never need to fork a workflow to change a prompt.",
        schema(
          {
            workflow: p.str("Workflow id, e.g. 'spec-kit'"),
            phase: p.str("Phase id, e.g. 'ui-design'"),
            text: p.str("The full prompt. Ignored when revert is true."),
            revert: p.bool("Discard the user's version and use the pack's again."),
          },
          ["workflow", "phase"],
        ),
        async ({ workflow, phase, text, revert }) => {
          const { writePhaseInstructions, revertPhaseInstructions } = await import("@/lib/specs/method/instructions");
          const i = revert === true
            ? await revertPhaseInstructions(String(workflow), String(phase))
            : await writePhaseInstructions(String(workflow), String(phase), String(text ?? ""));
          return revert === true
            ? `Reverted "${phase}" to the pack's instructions (${i.source}).`
            : `Wrote ${String(text ?? "").length} chars to "${phase}" at ${i.rel}, outside the pack.`;
        },
      ),
    ),

    /** 051 T024 — the agent's half of structural editing.
     *
     *  NOT parallel: it writes, and two concurrent ops on one workflow would
     *  each read the same `rev`, so the second would be refused as stale — a
     *  correct refusal for a wrong reason, and a confusing one to act on.
     *
     *  The SAME `applyWorkflowEdit` the canvas calls: same op set, same
     *  validator, same refusals, same gate warning. SC-011 is that there is one
     *  of each, and the only way to keep that true is for there to be one
     *  function. */
    methods_edit: serverTool(
      "methods_edit",
      "Change the STRUCTURE of a workflow the user owns: add, remove, rename, reorder a phase, mark it optional, set which phases gate it, set which artifacts it produces, or set which SKILLS perform it. To give a new phase something to run: add the phase, author a skill for it (a pack may ship a builder — BMAD has bmad-agent-builder and bmad-workflow-builder), then attach it with setSkills. Only works on a FORK — a pack's workflow is read-only, and the refusal will say so. To change a phase's PROMPT rather than its structure, use methods_phase_instructions_set, which needs no fork at all. Always pass the `rev` you last saw from methods_list or a previous edit. Use preview:true first when adding a gate (`requires`) — that is the one change that can block existing features, and the preview says how many.",
      schema(
        {
          workflow: p.str("A forked workflow's id"),
          rev: p.num("The revision you last saw. A mismatch is refused rather than overwriting someone else's edit."),
          op: p.str("One of: addPhase, removePhase, renamePhase, movePhase, setRequires, setOptional, setArtifacts, setSkills"),
          phase: p.str("The phase this op acts on (for addPhase, the id of the NEW phase)"),
          label: p.str("Display label — addPhase and renamePhase"),
          to: p.str("New phase id — renamePhase"),
          after: p.str("Place it after this phase; '' means first — addPhase and movePhase"),
          requires: p.strArr("The COMPLETE list of phases that must be done first — setRequires. Replaces the current list."),
          artifacts: p.strArr("The COMPLETE list of already-declared artifacts this phase produces — setArtifacts"),
          skills: p.strArr("The COMPLETE list of skill ids that PERFORM this phase — setSkills. A skill that is not installed yet is allowed and warned, so you may attach one you are about to author."),
          optional: p.bool("Whether the phase may be skipped — setOptional and addPhase"),
          preview: p.bool("Report what the change would do without applying it"),
        },
        ["workflow", "rev", "op", "phase"],
      ),
      async (args) => {
        const { applyWorkflowEdit, WorkflowEditRefused } = await import("@/lib/specs/method/authoring");
        const { describeGateImpact } = await import("@/lib/specs/method/gate-impact");
        const id = String(args.workflow);
        const phase = String(args.phase);
        const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

        let op: import("@/lib/specs/method/authoring").WorkflowOp;
        switch (String(args.op)) {
          case "addPhase":
            op = { op: "addPhase", id: phase, label: args.label ? String(args.label) : undefined, after: args.after ? String(args.after) : undefined, optional: args.optional === true };
            break;
          case "removePhase": op = { op: "removePhase", id: phase }; break;
          case "renamePhase":
            op = { op: "renamePhase", id: phase, to: args.to ? String(args.to) : undefined, label: args.label !== undefined ? String(args.label) : undefined };
            break;
          // `after: ''` is FIRST, and is why this reads the raw value rather
          // than truthiness — `movePhase` to position 0 is a normal thing to
          // want and would otherwise silently become "leave it where it is".
          case "movePhase": op = { op: "movePhase", id: phase, after: args.after ? String(args.after) : null }; break;
          case "setRequires": op = { op: "setRequires", id: phase, requires: strs(args.requires) }; break;
          case "setOptional": op = { op: "setOptional", id: phase, optional: args.optional === true }; break;
          case "setArtifacts": op = { op: "setArtifacts", id: phase, artifacts: strs(args.artifacts) }; break;
          case "setSkills": op = { op: "setSkills", id: phase, skills: strs(args.skills) }; break;
          default:
            return `"${String(args.op)}" is not an operation. Use one of: addPhase, removePhase, renamePhase, movePhase, setRequires, setOptional, setArtifacts, setSkills.`;
        }

        try {
          const r = await applyWorkflowEdit(id, op, Number(args.rev), { dryRun: args.preview === true });
          const lines = [
            r.preview
              ? `PREVIEW — nothing was written. Applying this would take "${id}" to revision ${r.workflow.rev}.`
              : `Applied. "${id}" is now at revision ${r.workflow.rev} — pass that as \`rev\` next time.`,
            ...r.warnings.map((w) => `  note: ${w}`),
          ];
          // The gate warning reaches the agent through the same field the canvas
          // renders, so neither route can be the one that skips it.
          if (r.gateImpact) lines.push("", describeGateImpact(r.gateImpact));
          return lines.join("\n");
        } catch (err) {
          // A refusal is a normal outcome carrying its reason — returned as
          // text, not thrown, so the agent reads "fork it first" rather than a
          // tool failure it will retry.
          if (err instanceof WorkflowEditRefused) return `Refused (${err.code}): ${err.message}`;
          throw err;
        }
      },
    ),

    /** 048 T021/FR-026 — a pack's runtime inside the USER'S repository.
     *
     *  Read and write are ONE tool with a `install` flag rather than two, so the
     *  agent cannot reach the write without having been told what it writes and
     *  where. The default is the report. */
    methods_project_runtime: serverTool(
      "methods_project_runtime",
      "Check whether a spec store's method needs supporting files inside the user's own git REPOSITORY (BMAD needs `_bmad/` for its scripts and team customisations), and optionally install them. Report first and tell the user which repository will be written to — this writes outside BOS's own data directory, into their source tree. Re-running is safe: it refreshes the pack's files and never touches paths the user owns.",
      schema(
        {
          store: p.str("Spec store id"),
          install: p.bool("Write the files. Omit to only report what is needed."),
        },
        ["store"],
      ),
      async ({ store, install }, ctx) => {
        const { projectRuntimeStatus, installProjectRuntime, describeProjectRuntime } =
          await import("@/lib/specs/method/project-runtime");
        const storeId = String(store);
        // The active branch, because an app created on one is not in any base
        // listing — and this tool is most needed for exactly that app, the one
        // just created under a pack that needs a runtime.
        const branch = (await specCtx(ctx))?.branch;

        if (install !== true) {
          const st = await projectRuntimeStatus(storeId, branch);
          if (!st.spec && !st.blocked) return `"${st.methodId}" needs nothing installed in the repository.`;
          return describeProjectRuntime(st);
        }

        const r = await installProjectRuntime(storeId, branch);
        if (r.blocked) return r.blocked;
        const lines = [`Installed ${r.written.length} file(s) into ${r.target}.`];
        if (r.preserved.length) {
          lines.push(`Left ${r.preserved.length} path(s) untouched because they are yours: ${r.preserved.join(", ")}.`);
        }
        lines.push(`That directory is inside the user's repository at ${r.projectRoot} — tell them it is there and that it is theirs to commit.`);
        return lines.join("\n");
      },
    ),

    methods_list: parallel(
      serverTool(
        "methods_list",
        "List every SPEC METHOD installed (spec-kit, BMAD, OpenSpec, and any fork of one): its phases IN ORDER, the DRIVER SKILL that teaches you to run it, and what each store is bound to. Call this FIRST for any spec work — authoring or advancing a feature through its phases. It answers 'what does this method do' outright — do NOT reconstruct a pipeline from step skills, and never from a pack's own spec, which describes how the pack was built rather than how to use it. NOT to be confused with `workflow_list`, which belongs to the Workflows app and lists automation workflows (multi-step agent runs) — a different thing entirely.",
        schema({}, []),
        async (_input, ctx) => {
          const { listWorkflows } = await import("@/lib/specs/method/workflows");
          const { listStores } = await import("@/lib/specs/stores");
          const { bindingScopeOf } = await import("@/lib/specs/store-kind");
          const wfs = listWorkflows();
          if (!wfs.length) return "No method packs are registered.";

          // The phases and the driver are the whole point: the descriptor
          // already states the pipeline, and withholding it is what made an
          // agent reverse-engineer it from three step skills and a spec.
          // 051 FR-013 — a fork must be visibly the USER'S, with what it came
          // from. Unmarked it reads as another pack's workflow, and the agent
          // cannot tell that upstream fixes will never reach it.
          const { listUserWorkflowIds, readUserWorkflow } = await import("@/lib/specs/method/user-workflows");
          const mine = new Map<string, { from: string; fromVersion: string }>();
          for (const uid of await listUserWorkflowIds()) {
            const uw = await readUserWorkflow(uid);
            if (uw?.kind === "fork") mine.set(uid, { from: uw.from, fromVersion: uw.fromVersion });
          }

          const lines = wfs.flatMap((w) => {
            const m = w.method;
            const own = mine.get(m.id);
            const tag = own ? `  (YOURS — forked from ${own.from} @ ${own.fromVersion}; upstream changes do NOT reach it)` : "";
            const out = [`  ${w.qualified}${w.isDefault ? `  (default for ${m.id})` : ""}${tag}  — ${w.label}`];
            out.push(`      phases: ${m.phases.map((p) => p.id).join(" -> ")}`);
            out.push(
              m.driverSkill
                ? `      driver skill: ${m.driverSkill}   <- skill_load this to run it`
                : `      driver skill: NONE DECLARED — this pack does not say how to run it; report that rather than guessing`,
            );
            if (Object.keys(m.roles ?? {}).length) {
              out.push(`      roles: ${Object.entries(m.roles).map(([r, a]) => `${r}=${a}`).join(", ")}`);
            }
            return out;
          });
          // `workflow ?? method` — the same pair everything else resolves. Reading
          // only `method` reported "no binding" for every store bound BY
          // WORKFLOW, which is how a store gets bound now.
          const stores = (await listStores((await specCtx(ctx))?.branch)).map((s) => {
            const bound = s.workflow ?? s.method;
            return `  ${s.id}  binds at: ${bindingScopeOf(s)}${bound ? `  currently: ${bound}` : ""}`;
          });
          return [
            "Spec methods (address a workflow bare when unambiguous, else <method>:<workflow>):",
            ...lines,
            "",
            "Stores:",
            ...stores,
          ].join("\n");
        },
      ),
    ),
    create_project: serverTool(
      "create_project",
      "Create a project in a spec store. WHAT a project is depends on the store: in a marketplace store it is an ITEM (a new app/service/pack), in a BOS user-spec store or an arbitrary repo it is a folder/module that groups features. `workflow` names the spec framework's pipeline (e.g. 'bmad', 'bmad:enterprise', 'openspec') and is accepted ONLY for a marketplace store, where each project binds its own; elsewhere the whole store binds one. Use this instead of writing project.json by hand.",
      schema(
        {
          store: p.str("Spec store id, e.g. 'user-specs' or 'user-apps'"),
          name: p.str("Human name, e.g. 'Network Filesystem support'"),
          workflow: p.str("Workflow to bind (marketplace stores only)"),
        },
        ["store", "name"],
      ),
      async (input, ctx) => {
        const { createProjectIn } = await import("@/lib/specs/lifecycle");
        const r = await createProjectIn(String(input.store ?? ""), String(input.name ?? ""), {
          branch: (await specCtx(ctx))?.branch,
          workflow: input.workflow ? String(input.workflow) : undefined,
        });
        return `Created ${r.unit} "${r.id}" at ${r.path}`;
      },
    ),
    rename_project: serverTool(
      "rename_project",
      "Rename a project. Moves its directory AND its manifest label together.",
      schema(
        { store: p.str("Spec store id"), project: p.str("Current project id"), name: p.str("New human name") },
        ["store", "project", "name"],
      ),
      async (input, ctx) => {
        const { renameProjectIn } = await import("@/lib/specs/lifecycle");
        const r = await renameProjectIn(String(input.store ?? ""), String(input.project ?? ""), String(input.name ?? ""), {
          branch: (await specCtx(ctx))?.branch,
        });
        return `Renamed to "${r.label}" (${r.id})`;
      },
    ),
    delete_project: serverTool(
      "delete_project",
      "Delete a project and everything in it. DESTRUCTIVE: call once WITHOUT `confirm` to see what would be removed, show the user that count, and only pass confirm: true after they agree. Never pass confirm: true on the first call.",
      schema(
        { store: p.str("Spec store id"), project: p.str("Project id"), confirm: p.bool("Only after the user has agreed") },
        ["store", "project"],
      ),
      async (input, ctx) => {
        const lc = await import("@/lib/specs/lifecycle");
        const store = String(input.store ?? "");
        const project = String(input.project ?? "");
        const d = await lc.describeProjectDeletion(store, project);
        // FR-006: a count is what separates "delete the empty folder I just
        // made" from "delete 30 specs". The elicitation is the tool's, not the
        // caller's, so an agent cannot skip it by not asking.
        if (input.confirm !== true) {
          return `NOT DELETED. Deleting "${d.label}" would remove ${d.units} unit(s). Show this to the user and call again with confirm: true only if they agree.`;
        }
        await lc.deleteProjectIn(store, project, { branch: (await specCtx(ctx))?.branch });
        return `Deleted "${d.label}" (${d.units} unit(s)).`;
      },
    ),
  };
}

export function itemSpecTools(): Record<string, AssistantTool> {
  return {
    app_spec_create: serverTool(
      "app_spec_create",
      "Create a marketplace item's spec.md, bringing the item itself into existence (symlinked, git-committed) even before any app/service/plugin code exists — the SAME mechanism app_install/app_build use. Use this the moment you decide something is going to be a marketplace item, not a BOS-core feature. Omit `id` to derive a fresh one from `name`; pass an existing item's id to add a spec to it (fails if it already has one — use app_spec_write/app_spec_edit instead). PASS `workflow` whenever the user named a method (\"build an app using BMAD\") — it decides the primary artifact's NAME and is recorded as the item's binding, and an item created without it is permanently on the global default until someone rebinds it by hand. `methods_list` names the installed ones.",
      schema(
        {
          name: p.str("Item/feature name"),
          id: p.str("Explicit item id (optional)"),
          specBody: p.str("Full spec.md content"),
          workflow: p.str("Method or workflow to create this item under, e.g. 'bmad' (optional; defaults to the global default method)"),
        },
        ["name", "specBody"],
      ),
      async (input, ctx) => {
        const workflow = typeof input.workflow === "string" && input.workflow.trim() ? input.workflow.trim() : undefined;
        const { id, path } = await createItemSpec({
          name: String(input.name ?? ""),
          id: input.id ? String(input.id) : undefined,
          specBody: String(input.specBody ?? ""),
          ...(workflow ? { workflow } : {}),
          branch: (await specCtx(ctx))?.branch,
        });
        // Named back, because the method decides which artifacts come next and
        // an agent that silently got the default would author the wrong ones.
        return `Created item "${id}" with spec at ${path}${workflow ? `, bound to "${workflow}"` : ""}`;
      },
    ),
    app_spec_list: parallel(
      serverTool(
        "app_spec_list",
        "List entries in a marketplace item's spec store, e.g. 'item-widget' to list its artifacts.",
        schema({ path: p.str("Store-prefixed dir, e.g. 'item-widget'") }, ["path"]),
        async (input, ctx) => {
          await requireItemStore(String(input.path ?? ""), "app_spec_list", (await specCtx(ctx))?.branch);
          return JSON.stringify(await specfs.listDir(String(input.path ?? ""), await specCtx(ctx)));
        },
      ),
    ),
    app_spec_read: parallel(
      serverTool(
        "app_spec_read",
        "Read a marketplace item's spec artifact by its STORE-PREFIXED path, e.g. 'item-widget/spec.md'.",
        schema({ path: p.str("Store-prefixed artifact path") }, ["path"]),
        async (input, ctx) => {
          await requireItemStore(String(input.path ?? ""), "app_spec_read", (await specCtx(ctx))?.branch);
          return specfs.readFile(String(input.path ?? ""), await specCtx(ctx));
        },
      ),
    ),
    app_spec_write: serverTool(
      "app_spec_write",
      "Replace the ENTIRE content of an existing marketplace-item spec artifact (STORE-PREFIXED path, e.g. 'item-widget/plan.md'). Prefer app_spec_edit/app_spec_patch for a targeted change. Refused if the item is marketplace-sourced (read-only) rather than the user's own.",
      schema({ path: p.str("Store-prefixed artifact path"), content: p.str("Full file content") }, ["path", "content"]),
      async (input, ctx) => {
        await requireItemStore(String(input.path ?? ""), "app_spec_write", (await specCtx(ctx))?.branch);
        // Same guard as the API route: an agent editing archived history is the
        // more likely case, not the less, since it cannot see a greyed-out row.
        const { assertEditablePath } = await import("@/lib/specs/pipeline");
        await assertEditablePath(String(input.path ?? ""));
        return `Wrote ${await specfs.writeFile(String(input.path ?? ""), String(input.content ?? ""), await specCtx(ctx))}`;
      },
    ),
    app_spec_edit: serverTool(
      "app_spec_edit",
      "Replace a unique snippet of text in a marketplace-item spec artifact (STORE-PREFIXED path; the search text must occur exactly once).",
      schema(
        { path: p.str("Store-prefixed artifact path"), find: p.str("Exact text to find (must occur exactly once)"), replace: p.str("Replacement text") },
        ["path", "find", "replace"],
      ),
      async (input, ctx) => {
        await requireItemStore(String(input.path ?? ""), "app_spec_edit", (await specCtx(ctx))?.branch);
        return `Edited ${await specfs.editFile(String(input.path ?? ""), String(input.find ?? ""), String(input.replace ?? ""), await specCtx(ctx))}`;
      },
    ),
    app_spec_patch: serverTool(
      "app_spec_patch",
      "Apply one or more targeted find/replace edits to an existing marketplace-item spec artifact (STORE-PREFIXED path) in a single atomic change. Each hunk's `find` must occur exactly once at the moment it applies; hunks apply in order. If any hunk fails, nothing is written.",
      schema(
        {
          path: p.str("Store-prefixed artifact path"),
          hunks: {
            type: "array",
            description: "Ordered edits; each replaces the single occurrence of `find` with `replace`.",
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "Exact text to find (must be unique when this hunk applies)" },
                replace: { type: "string", description: "Replacement text" },
              },
              required: ["find", "replace"],
            },
          },
        },
        ["path", "hunks"],
      ),
      async (input, ctx) => {
        await requireItemStore(String(input.path ?? ""), "app_spec_patch", (await specCtx(ctx))?.branch);
        const hunks = (input.hunks as specfs.SpecHunk[]) ?? [];
        return `Patched ${await specfs.patchFile(String(input.path ?? ""), hunks, await specCtx(ctx))}`;
      },
    ),
  };
}
