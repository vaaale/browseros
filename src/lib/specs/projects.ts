import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import { logger } from "@/lib/logging";
import { isLeafDir } from "./leaf";
import type { MethodDescriptor } from "./method/types";
import { PROJECT_MANIFEST } from "@/lib/specs/stores";

const COMPONENT = "specs.projects";

// Project layer (033): one new grouping folder directly under a directory-scanned
// store's root, `<storeId>/<projectId>/`, marked by owning a `project.json`
// manifest. Below a project, arbitrary plain sub-folders are allowed for
// organization only — they carry no manifest of their own. A directory (at any
// depth under a project) is a "feature leaf" iff it directly contains spec.md;
// pipeline.ts's recursive walk uses that rule, not depth, to find features.
// Discovery mirrors stores.ts: list the container, no central registry.
// Item-owned stores (item-stores.ts) never have projects — callers must not
// invoke this module for a store whose owner is "item".

export interface ProjectManifest {
  label: string;
  description?: string;
  /** 049 FR-009: the WORKFLOW this project uses. Supersedes `method`, which
   *  keeps resolving as "that method's default workflow" and MUST NOT be
   *  dropped when BOS rewrites the manifest — 045 FR-019's preservation rule
   *  applied to our own migration. */
  workflow?: string;
  /** 045 FR-008: a per-Project override of the store's method. The most
   *  specific binding wins, so one Project can pilot a new framework without
   *  moving the rest of the store. */
  method?: string;
}

export interface Project extends ProjectManifest {
  /** Subdirectory name under the store root (the project id). */
  id: string;
  store: string;
  /** Store-prefixed path, e.g. "bos-system-specs/bos". */
  path: string;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

async function readProjectManifest(storeId: string, projectId: string): Promise<ProjectManifest | null> {
  try {
    const raw = await specfs.readFile(`${storeId}/${projectId}/${PROJECT_MANIFEST}`);
    const m = JSON.parse(raw) as Record<string, unknown> & Partial<ProjectManifest>;
    const label = typeof m.label === "string" && m.label.trim() ? m.label.trim() : projectId;
    const description = typeof m.description === "string" && m.description.trim() ? m.description.trim() : undefined;
    const method = typeof m.method === "string" && m.method.trim() ? m.method.trim() : undefined;
    const workflow = typeof m.workflow === "string" && m.workflow.trim() ? m.workflow.trim() : undefined;
    // SPREAD, then narrow (045 FR-019). Reconstructing from named fields is the
    // trap that has now bitten five readers in this subsystem, and it is worse
    // here than it looks: BOS REWRITES project.json on rename, so a key this
    // module does not model is not merely ignored on read — it is deleted from
    // the user's repository on the next write, and committed.
    return {
      ...m,
      label,
      ...(description ? { description } : {}),
      ...(method ? { method } : {}),
      ...(workflow ? { workflow } : {}),
    };
  } catch (err) {
    // "No project.json" means "not a Project" — the normal case, and the only
    // one defaulted. A CORRUPT manifest is not: reporting it as absent makes the
    // project vanish from the tree, which reads as data loss and hides the one
    // file that would explain it.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      logger().error(COMPONENT, "project.json is not valid JSON — this project will not be listed", undefined, {
        storeId,
        projectId,
        error: err.message,
      });
      return null;
    }
    throw err;
  }
}

/** Every Project directly under a store — top-level dirs owning a project.json. */
export async function listProjects(storeId: string): Promise<Project[]> {
  // A store whose directory does not exist yet lists as empty. Anything else is
  // a real failure and must not be reported as "this store has no projects".
  const top = await specfs.listDir(storeId).catch((err: NodeJS.ErrnoException) => {
    if (err?.code === "ENOENT") return [];
    throw err;
  });
  const out: Project[] = [];
  for (const e of top) {
    if (e.type !== "dir") continue;
    const manifest = await readProjectManifest(storeId, e.name);
    if (!manifest) continue; // no project.json => not a Project (legacy loose dir, or a plain folder that somehow ended up at store root)
    out.push({ id: e.name, store: storeId, path: `${storeId}/${e.name}`, ...manifest });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getProject(storeId: string, projectId: string): Promise<Project | undefined> {
  const manifest = await readProjectManifest(storeId, projectId);
  if (!manifest) return undefined;
  return { id: projectId, store: storeId, path: `${storeId}/${projectId}`, ...manifest };
}

/** Create a new Project at the store's top level: a fresh dir + project.json,
 *  committed via the normal spec-fs write path. Returns the created Project. */
export async function createProject(
  storeId: string,
  name: string,
  description?: string,
  /** 049 FR-013: every lifecycle write rides the active feature branch, like
   *  any other spec write. Optional only so the existing call sites (tests, and
   *  stores that are not branch-coupled) keep compiling. */
  ctx?: { branch?: string },
): Promise<Project> {
  const existing = new Set((await listProjects(storeId)).map((p) => p.id));
  const base = slugify(name);
  let id = base;
  let suffix = 2;
  while (existing.has(id)) id = `${base}-${suffix++}`;
  const manifest: ProjectManifest = { label: name.trim() || id, ...(description ? { description } : {}) };
  await specfs.writeFile(`${storeId}/${id}/${PROJECT_MANIFEST}`, JSON.stringify(manifest, null, 2) + "\n", ctx);
  return { id, store: storeId, path: `${storeId}/${id}`, ...manifest };
}

/** True iff `<storeId>/<relPath>` is a unit leaf under `descriptor`.
 *
 *  Delegates to the ONE leaf rule (leaf.ts) — this used to hardcode spec.md,
 *  which was the fourth copy of it (SC-004). The descriptor is a parameter
 *  rather than resolved here so this module stays free of a dependency on the
 *  method registry, and so callers cannot accidentally test a directory
 *  against a method the store is not bound to. */
export async function isFeatureLeaf(storeId: string, relPath: string, descriptor: MethodDescriptor): Promise<boolean> {
  return isLeafDir(storeId, relPath, descriptor);
}

// ---------------------------------------------------------------------------
// 049 — project lifecycle. ONE implementation, shared by the agent tools and
// the Build Studio context menus (FR-010). Every divergence in this subsystem
// so far has come from two paths to the same outcome.
// ---------------------------------------------------------------------------

/** Rename a project: its directory AND its manifest label move together.
 *
 *  Both, because they are two halves of one identity. Moving the directory
 *  without the label leaves a project whose displayed name is the old one; the
 *  reverse leaves a label nothing resolves to. */
export async function renameProject(
  storeId: string,
  projectId: string,
  newName: string,
  ctx?: { branch?: string },
): Promise<Project> {
  const existing = await getProject(storeId, projectId);
  if (!existing) throw new Error(`Store "${storeId}" has no Project "${projectId}".`);

  const label = newName.trim();
  if (!label) throw new Error("A project name is required.");

  const taken = new Set((await listProjects(storeId)).map((p) => p.id));
  taken.delete(projectId);
  let id = slugify(label);
  const base = id;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

  if (id !== projectId) {
    await specfs.rename(`${storeId}/${projectId}`, `${storeId}/${id}`, ctx);
  }
  // MERGE, never reconstruct: a manifest may carry keys this module does not
  // model, and rewriting from known fields deletes them from the user's repo
  // (045 FR-019 — the trap that bit four readers in this subsystem).
  const manifest = { ...existing, label } as Record<string, unknown>;
  delete manifest.id;
  delete manifest.store;
  delete manifest.path;
  await specfs.writeFile(`${storeId}/${id}/${PROJECT_MANIFEST}`, JSON.stringify(manifest, null, 2) + "\n", ctx);

  return { ...(manifest as unknown as ProjectManifest), id, store: storeId, path: `${storeId}/${id}` };
}

/** How many units a project holds — the number a delete confirmation must
 *  quote (FR-006). "Delete the empty folder I just made" and "delete 30 specs"
 *  are the same click otherwise. */
export async function projectUnitCount(storeId: string, projectId: string, descriptor: MethodDescriptor): Promise<number> {
  const { isLeafListing } = await import("./leaf");
  const walk = async (rel: string): Promise<number> => {
    // This count gates a destructive confirmation, so a failed read must NOT
    // become "nothing here". Only a missing directory counts as zero.
    const entries = await specfs.listDir(`${storeId}/${rel}`).catch((err: NodeJS.ErrnoException) => {
      if (err?.code === "ENOENT") return [];
      throw err;
    });
    if (isLeafListing(entries, descriptor, rel)) return 1;
    let n = 0;
    for (const e of entries) if (e.type === "dir") n += await walk(`${rel}/${e.name}`);
    return n;
  };
  return walk(projectId);
}

/** Delete a project and everything in it.
 *
 *  Deliberately takes no `force`/`confirm` flag: confirmation belongs to the
 *  CALLER's surface (a dialog, a tool's elicitation), and a boolean passed
 *  through an API is not a confirmation — it is a parameter an agent can set. */
export async function deleteProject(storeId: string, projectId: string, ctx?: { branch?: string }): Promise<void> {
  const existing = await getProject(storeId, projectId);
  if (!existing) throw new Error(`Store "${storeId}" has no Project "${projectId}".`);
  await specfs.remove(`${storeId}/${projectId}`, ctx);
}
