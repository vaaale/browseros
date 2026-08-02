import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import { listStores } from "@/lib/specs/stores";
import { listDraftBranches, draftChangedFiles, listBranchDirFiles } from "@/lib/specs/store-git";
import { ensureStoresOnce } from "@/lib/specs/seed";
import {
  ARTIFACT_FILES,
  type Artifact,
  type PhaseId,
  type PipelinePhase,
  type Specification,
  type SpecTreeNode,
  type Task,
} from "./types";

// Post-018 specs live in external stores (one git repo per store) under
// BOS_SPECS_ROOT. Paths here are STORE-PREFIXED: `<storeId>/<featureId>/...`.
// The constitution + discrepancies are content of the system store.

const CONSTITUTION_REL = ".specify/memory/constitution.md";

async function readOr(p: string, fallback = ""): Promise<string> {
  try {
    return await specfs.readFile(p);
  } catch {
    return fallback;
  }
}

/** Parse `- [ ] T001 ...` / `- [x] ...` checklist items from a tasks.md body. */
export function parseTasks(content: string): Task[] {
  const out: Task[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s+(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    const idMatch = text.match(/^(T\d+[a-z]?)\b/);
    out.push({ id: idMatch ? idMatch[1] : "", text, done: m[1].toLowerCase() === "x" });
  }
  return out;
}

function titleFromSpec(specBody: string, fallback: string): string {
  const h1 = specBody.match(/^#\s+(.*)$/m);
  if (!h1) return fallback;
  return h1[1].replace(/^Feature Specification:\s*/i, "").trim() || fallback;
}

/** The store that owns system-level artifacts (constitution, discrepancies). */
async function systemStoreId(): Promise<string | undefined> {
  const stores = await listStores();
  return (stores.find((s) => s.owner === "system") ?? stores[0])?.id;
}

let constitutionReady: boolean | undefined;
async function hasConstitution(): Promise<boolean> {
  if (constitutionReady !== undefined) return constitutionReady;
  const sid = await systemStoreId();
  const body = sid ? await readOr(`${sid}/${CONSTITUTION_REL}`) : "";
  // "Ready" = present and not the placeholder template (which is full of [TOKENS]).
  constitutionReady = body.length > 0 && !body.includes("[PROJECT_NAME]");
  return constitutionReady;
}

async function derivePhases(
  featurePath: string,
  featureId: string,
  artifactNames: Set<string>,
  branch?: string,
): Promise<PipelinePhase[]> {
  // Draft-branch content (020) is read at the branch, not base — a spec being
  // actively written on a feature branch has no base copy to fall back to.
  const read = (rel: string) => (branch ? specfs.readFileAt(`${featurePath}/${rel}`, branch).catch(() => "") : readOr(`${featurePath}/${rel}`));
  const spec = artifactNames.has("spec.md") ? await read("spec.md") : "";
  const tasksBody = artifactNames.has("tasks.md") ? await read("tasks.md") : "";
  const tasks = parseTasks(tasksBody);
  const done = tasks.filter((t) => t.done).length;
  const sid = await systemStoreId();
  const discrepancies = sid ? await readOr(`${sid}/discrepancies.md`) : "";

  const phase = (id: PhaseId, state: PipelinePhase["state"]): PipelinePhase => ({ id, state });

  let implementState: PipelinePhase["state"] = "na";
  if (tasks.length > 0) implementState = done === tasks.length ? "done" : done > 0 ? "pending" : "na";

  const testResults = artifactNames.has("test-results.md") ? await read("test-results.md") : "";
  let testState: PipelinePhase["state"] = "na";
  if (testResults) testState = testResults.includes("**Status**: PASSED") ? "done" : "pending";

  return [
    phase("constitution", (await hasConstitution()) ? "done" : "pending"),
    phase("specify", artifactNames.has("spec.md") ? "done" : "pending"),
    phase("clarify", spec.includes("## Clarifications") ? "done" : artifactNames.has("spec.md") ? "pending" : "na"),
    phase("plan", artifactNames.has("plan.md") ? "done" : artifactNames.has("spec.md") ? "pending" : "na"),
    phase("tasks", artifactNames.has("tasks.md") ? "done" : artifactNames.has("plan.md") ? "pending" : "na"),
    phase("analyze", "na"),
    phase("implement", implementState),
    phase("converge", discrepancies.includes(featureId) ? "done" : "na"),
    phase("test", testState),
  ];
}

/** `opts.branch` + `opts.files` (store-prefixed paths, from listBranchDirFiles)
 *  build a Specification purely from a draft `bos/*` branch — used when the
 *  feature doesn't exist on base at all yet (020). Omit both for the normal
 *  base-store case. */
async function buildSpecification(storeId: string, id: string, opts?: { branch?: string; files?: string[] }): Promise<Specification> {
  const featurePath = `${storeId}/${id}`;
  const branch = opts?.branch;
  const artifacts: Artifact[] = branch
    ? (opts?.files ?? [])
        .filter((p) => p.endsWith(".md"))
        .map((p) => ({ name: p.split("/").pop() ?? p, path: p }))
    : (await specfs.listDir(featurePath).catch(() => []))
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .map((e) => ({ name: e.name, path: e.path }));
  const artifactNames = new Set(artifacts.map((a) => a.name));

  const read = (rel: string) => (branch ? specfs.readFileAt(`${featurePath}/${rel}`, branch).catch(() => "") : readOr(`${featurePath}/${rel}`));
  const specBody = artifactNames.has("spec.md") ? await read("spec.md") : "";
  const tasksBody = artifactNames.has("tasks.md") ? await read("tasks.md") : "";
  const tasks = parseTasks(tasksBody);

  return {
    id,
    store: storeId,
    title: titleFromSpec(specBody, id),
    path: featurePath,
    artifacts: artifacts.sort(byArtifactOrder),
    phases: await derivePhases(featurePath, id, artifactNames, branch),
    taskProgress: tasks.length ? { done: tasks.filter((t) => t.done).length, total: tasks.length } : undefined,
    ...(branch ? { branch } : {}),
  };
}

function byArtifactOrder(a: Artifact, b: Artifact): number {
  const order = ARTIFACT_FILES as readonly string[];
  const ia = order.indexOf(a.name);
  const ib = order.indexOf(b.name);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.name.localeCompare(b.name);
}

/** All feature folders across all stores, each with derived pipeline status.
 *
 *  Also surfaces features that only exist as drafts on an active `bos/*`
 *  feature branch (020) — pushed AFTER the base scan so a feature touched on
 *  both wins with the draft (more current) version once the client keys a Map
 *  by `path`. Without this, a spec written entirely on a feature branch (the
 *  ordinary case while working through the spec-kit pipeline) has no entry
 *  here at all — `specTree()` already discovers it for the sidebar, but this
 *  function silently didn't, leaving Build Studio's PhaseStrip badges blank
 *  for exactly the specs a user is most likely to be actively looking at. */
export async function listSpecifications(): Promise<Specification[]> {
  await ensureStoresOnce();
  constitutionReady = undefined; // re-evaluate per request
  const specs: Specification[] = [];
  for (const store of await listStores()) {
    const top = await specfs.listDir(store.id).catch(() => []);
    for (const f of top.filter((e) => e.type === "dir")) {
      specs.push(await buildSpecification(store.id, f.name));
    }
    for (const branch of await listDraftBranches(store.root).catch(() => [] as string[])) {
      const changed = await draftChangedFiles(store.root, branch).catch(() => [] as string[]);
      const touched = new Set<string>();
      for (const rel of changed) {
        const [featureId, ...rest] = rel.split("/");
        if (!featureId || !rest.length) continue; // loose root files: not a feature
        touched.add(featureId);
      }
      for (const featureId of touched) {
        const files = (await listBranchDirFiles(store.root, branch, featureId).catch(() => [] as string[])).map((rel) => `${store.id}/${rel}`);
        specs.push(await buildSpecification(store.id, featureId, { branch, files }));
      }
    }
  }
  return specs.sort((a, b) => (a.store === b.store ? a.id.localeCompare(b.id) : a.store.localeCompare(b.store)));
}

/** Fetch one specification by its store-prefixed path `<storeId>/<featureId>`.
 *  Falls back to a draft `bos/*` branch (020) when the feature has no base
 *  copy — same reason as listSpecifications' fallback above. */
export async function getSpecification(fullPath: string): Promise<Specification | undefined> {
  const safe = fullPath.replace(/[^a-zA-Z0-9._/-]/g, "");
  const [storeId, id] = safe.split("/");
  if (!storeId || !id) return undefined;
  constitutionReady = undefined;
  if (await specfs.exists(`${storeId}/${id}`)) return buildSpecification(storeId, id);

  const store = (await listStores()).find((s) => s.id === storeId);
  if (!store) return undefined;
  for (const branch of await listDraftBranches(store.root).catch(() => [] as string[])) {
    const files = (await listBranchDirFiles(store.root, branch, id).catch(() => [] as string[])).map((rel) => `${storeId}/${rel}`);
    if (files.length > 0) return buildSpecification(storeId, id, { branch, files });
  }
  return undefined;
}

/** Every store as a group node (feature folders + loose files as children). */
export async function specTree(): Promise<SpecTreeNode[]> {
  await ensureStoresOnce();
  const groups: SpecTreeNode[] = [];
  for (const store of await listStores()) {
    const top = await specfs.listDir(store.id).catch(() => []);
    const children: SpecTreeNode[] = [];
    for (const e of top) {
      if (e.type === "dir") {
        const fileChildren = (await specfs.listDir(e.path).catch(() => []))
          .filter((c) => c.type === "file")
          .map<SpecTreeNode>((c) => ({ type: "file", name: c.name, path: c.path }));
        children.push({ type: "feature", name: e.name, path: e.path, children: fileChildren });
      } else {
        children.push({ type: "file", name: e.name, path: e.path });
      }
    }
    // Draft branches (020): features being worked on `bos/*` store branches,
    // rendered read-only from base without any checkout or preview.
    for (const branch of await listDraftBranches(store.root).catch(() => [] as string[])) {
      const changed = await draftChangedFiles(store.root, branch).catch(() => [] as string[]);
      // A feature is "touched" on the branch if any of its files changed. For each
      // such feature we list its FULL contents on the branch (not just the diff), so
      // the tree matches the branch/worktree — including artifacts (overview.md, etc.)
      // that are unchanged since the fork point and would otherwise be invisible.
      const touched = new Set<string>();
      for (const rel of changed) {
        const [featureId, ...rest] = rel.split("/");
        if (!featureId || !rest.length) continue; // loose root files: skip in the tree
        touched.add(featureId);
      }
      for (const featureId of touched) {
        const all = await listBranchDirFiles(store.root, branch, featureId).catch(() => [] as string[]);
        const files: SpecTreeNode[] = all.map((rel) => ({
          type: "file",
          name: rel.split("/").slice(1).join("/"),
          path: `${store.id}/${rel}`,
          branch,
        }));
        children.push({ type: "feature", name: featureId, path: `${store.id}/${featureId}`, branch, children: files });
      }
    }
    groups.push({
      type: "group",
      name: store.id,
      label: store.label,
      path: store.id,
      owner: store.owner,
      writable: store.writable,
      requiresPromote: store.requiresPromote,
      children,
    });
  }
  return groups;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "feature"
  );
}

/** Next spec-kit feature id in a store: `NNN-slug`, NNN = max existing + 1.
 *  Defaults to the writable user store. Returns `<storeId>/<NNN-slug>`. */
export async function nextFeatureId(name: string, storeId?: string): Promise<string> {
  await ensureStoresOnce();
  const stores = await listStores();
  const target = storeId
    ? stores.find((s) => s.id === storeId)
    : stores.find((s) => s.owner === "user" && s.writable) ?? stores.find((s) => s.writable);
  const top = target ? await specfs.listDir(target.id).catch(() => []) : [];
  let max = 0;
  const taken = new Set<string>();
  for (const e of top) {
    if (e.type !== "dir") continue;
    taken.add(e.name);
    const m = e.name.match(/^(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const num = String(max + 1).padStart(3, "0");
  const slug = slugify(name);
  let id = `${num}-${slug}`;
  let suffix = 2;
  while (taken.has(id)) id = `${num}-${slug}-${suffix++}`;
  return target ? `${target.id}/${id}` : id;
}
