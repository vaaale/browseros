// 049 — project lifecycle, dispatched on store KIND (FR-002a … FR-002c).
//
// ONE implementation. The agent tools and the Build Studio context menus both
// call this, because every divergence in this subsystem so far has come from two
// paths to the same outcome — and the UI is where a divergence is found last.
//
// "A project" is a different OBJECT in each kind of store:
//
//   marketplace store  -> an ITEM        (one repo, many products)
//   user-specs         -> a FOLDER       (037 grouping + feature numbering)
//   arbitrary repo     -> a FOLDER
//   bos-system-specs   -> nothing        (read-only)
//
// "One project" in the taxonomy describes BINDING SCOPE, not this. `user-specs`
// binds one workflow for everything in it AND still contains folders. Collapsing
// those two questions produced two wrong drafts of this feature, in opposite
// directions, so they are kept apart here by construction.

import "server-only";
import { listStores, type SpecStore } from "./stores";
import { bindingScopeOf, projectsAre, kindOf } from "./store-kind";
import { createProject, renameProject, deleteProject, listProjects, projectUnitCount } from "./projects";

export interface LifecycleCtx {
  /** The active `bos/*` feature branch. Every lifecycle write rides it (FR-013). */
  branch?: string;
}

export interface ProjectRef {
  store: string;
  /** Item id or folder id, depending on the store's kind. */
  id: string;
  label: string;
  path: string;
  /** What this project IS here — so a caller can word its own message. */
  unit: "item" | "folder";
}

/** The user's own marketplace, addressed as a store.
 *
 *  `listStores()` yields `item-<id>` stores, one per item — it has never yielded
 *  a store for the marketplace REPO that holds them, because until the 049
 *  taxonomy nothing needed one. The "User Apps" heading in the tree is
 *  client-synthetic for the same reason.
 *
 *  So it is synthesised here rather than left unreachable, which would make
 *  "create a document-processing app" — the question this feature exists to
 *  answer — the one case the tool could not serve. `050` re-models this
 *  properly by making a marketplace a real store; this is the seam until then,
 *  and it is deliberately the ONLY place that special-cases the id. */
const LOCAL_MARKETPLACE = "user-apps";

function localMarketplaceStore(): SpecStore {
  return {
    id: LOCAL_MARKETPLACE,
    root: "",
    repoRoot: "",
    repoOffset: "",
    label: "My Apps",
    owner: "marketplace",
    writable: true,
    requiresPromote: false,
  };
}

/** Resolve a store id for an OPERATION, marketplace included.
 *
 *  EXPORTED because it was duplicated. `POST /api/specs` re-checked the store
 *  against `listStores()` before dispatching here — and `listStores()` is
 *  exactly what does not yield the marketplace — so the door was shut on the one
 *  op this synthesis exists for: "New app" answered
 *  `Unknown spec store "user-apps"`. Build Studio's own comment claimed it
 *  "mirrors the single place lifecycle.ts synthesises the same store
 *  server-side"; there were two places, and only this one knew. */
export async function resolveOpStore(storeId: string, branch?: string): Promise<SpecStore | undefined> {
  if (storeId === LOCAL_MARKETPLACE) return localMarketplaceStore();
  // Base first, branch only on a miss — an app created ON the branch exists in
  // no base listing, and an op against it (binding its method, above all) would
  // otherwise be refused as an unknown store. Same order, and the same reason,
  // as spec-fs's resolveInStore: the branch lookup costs a Supervisor round
  // trip, so only the case that needs it pays.
  const base = (await listStores()).find((s) => s.id === storeId);
  if (base || !branch) return base;
  return (await listStores(branch)).find((s) => s.id === storeId);
}

async function storeOrThrow(storeId: string): Promise<SpecStore> {
  const store = await resolveOpStore(storeId);
  if (!store) throw new Error(`Unknown spec store "${storeId}".`);
  return store;
}

/** Refuse, with the reason, rather than silently doing something adjacent. */
function assertHasProjects(store: SpecStore): "item" | "folder" {
  const unit = projectsAre(store);
  if (unit === "none") {
    throw new Error(
      kindOf(store) === "system"
        ? `"${store.id}" is BOS's own spec store and is read-only — it has no projects to manage.`
        : `"${store.id}" is itself a single project, so it contains none.`,
    );
  }
  return unit === "items" ? "item" : "folder";
}

/** Create a project: a marketplace ITEM, or a folder in a store-scoped repo.
 *
 *  `workflow` is accepted ONLY where binding scope is per-project (FR-002c).
 *  Silently ignoring it would record an intent the product does not honour;
 *  silently applying it would make one folder disagree with the store it lives
 *  in. Both are worse than refusing and naming where the binding actually
 *  lives. */
export async function createProjectIn(
  storeId: string,
  name: string,
  opts: LifecycleCtx & { workflow?: string } = {},
): Promise<ProjectRef> {
  const store = await storeOrThrow(storeId);
  if (!store.writable) throw new Error(`Store "${storeId}" is read-only.`);
  const unit = assertHasProjects(store);

  if (opts.workflow && bindingScopeOf(store) !== "project") {
    throw new Error(
      `"${storeId}" binds ONE workflow for everything in it, so a per-project workflow cannot apply here. ` +
        `Set the store's own method instead, then create the project.`,
    );
  }

  if (unit === "item") {
    // A marketplace store's projects ARE its items, so this is item creation —
    // the same mechanism app_spec_create uses, not a parallel one.
    const { createItemSpec } = await import("./create");
    // Binding is createItemSpec's own, so this path and the agent's
    // (app_spec_create) cannot differ. It used to be done here afterwards,
    // which meant only the caller that remembered got a bound item.
    const { id, path } = await createItemSpec({
      name,
      specBody: `# ${name.trim()}\n`,
      branch: opts.branch,
      ...(opts.workflow ? { workflow: opts.workflow } : {}),
    });
    return { store: storeId, id, label: name.trim(), path, unit };
  }

  const project = await createProject(storeId, name, undefined, opts);
  return { store: storeId, id: project.id, label: project.label, path: project.path, unit };
}

export async function renameProjectIn(
  storeId: string,
  projectId: string,
  newName: string,
  ctx: LifecycleCtx = {},
): Promise<ProjectRef> {
  const store = await storeOrThrow(storeId);
  if (!store.writable) throw new Error(`Store "${storeId}" is read-only.`);
  const unit = assertHasProjects(store);
  if (unit === "item") {
    throw new Error(
      `Renaming a marketplace item is not a spec operation — its id is its install identity ` +
        `(data/system/<id>) and is referenced by the marketplace manifest. Not supported here.`,
    );
  }
  const p = await renameProject(storeId, projectId, newName, ctx);
  return { store: storeId, id: p.id, label: p.label, path: p.path, unit };
}

/** What a delete confirmation must quote (FR-006).
 *
 *  "Delete the empty folder I just made" and "delete 30 specs" are the same
 *  click without a count. */
export async function describeProjectDeletion(
  storeId: string,
  projectId: string,
): Promise<{ label: string; units: number; unit: "item" | "folder" }> {
  const store = await storeOrThrow(storeId);
  const unit = assertHasProjects(store);
  const project = (await listProjects(storeId)).find((p) => p.id === projectId);
  if (!project && unit === "folder") throw new Error(`Store "${storeId}" has no project "${projectId}".`);

  const { methodForStore } = await import("./pipeline");
  const descriptor = await methodForStore(storeId);
  // NOT `.catch(() => 0)`. This number IS the confirmation: a count that failed
  // and reported 0 tells the user "this removes 0 units", and they confirm
  // deleting thirty specs believing the folder is empty. A swallowed error that
  // yields a PLAUSIBLE value is worse than one that yields a crash.
  const units = await projectUnitCount(storeId, projectId, descriptor);
  return { label: project?.label ?? projectId, units, unit };
}

export async function deleteProjectIn(storeId: string, projectId: string, ctx: LifecycleCtx = {}): Promise<void> {
  const store = await storeOrThrow(storeId);
  if (!store.writable) throw new Error(`Store "${storeId}" is read-only.`);
  const unit = assertHasProjects(store);
  if (unit === "item") {
    throw new Error(
      `Deleting a marketplace item is an uninstall plus a repository change, not a spec operation. ` +
        `Not supported here.`,
    );
  }
  await deleteProject(storeId, projectId, ctx);
}
