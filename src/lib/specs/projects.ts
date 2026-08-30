import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import { PROJECT_MANIFEST } from "@/lib/specs/stores";

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
    const m = JSON.parse(raw) as Partial<ProjectManifest>;
    const label = typeof m.label === "string" && m.label.trim() ? m.label.trim() : projectId;
    const description = typeof m.description === "string" && m.description.trim() ? m.description.trim() : undefined;
    return { label, description };
  } catch {
    return null;
  }
}

/** Every Project directly under a store — top-level dirs owning a project.json. */
export async function listProjects(storeId: string): Promise<Project[]> {
  const top = await specfs.listDir(storeId).catch(() => []);
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
export async function createProject(storeId: string, name: string, description?: string): Promise<Project> {
  const existing = new Set((await listProjects(storeId)).map((p) => p.id));
  const base = slugify(name);
  let id = base;
  let suffix = 2;
  while (existing.has(id)) id = `${base}-${suffix++}`;
  const manifest: ProjectManifest = { label: name.trim() || id, ...(description ? { description } : {}) };
  await specfs.writeFile(`${storeId}/${id}/${PROJECT_MANIFEST}`, JSON.stringify(manifest, null, 2) + "\n");
  return { id, store: storeId, path: `${storeId}/${id}`, ...manifest };
}

/** True iff `<storeId>/<relPath>` directly contains spec.md — the sole rule
 *  that makes a directory (at any depth under a project) a feature leaf. */
export async function isFeatureLeaf(storeId: string, relPath: string): Promise<boolean> {
  return specfs.exists(`${storeId}/${relPath}/spec.md`);
}
