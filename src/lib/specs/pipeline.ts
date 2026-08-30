import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import { logger } from "@/lib/logging/server-logger";
import { listStores, type SpecStore } from "@/lib/specs/stores";
import { listDraftBranches, draftChangedFiles, listBranchDirFiles, listAllBranchFiles } from "@/lib/specs/store-git";
import { listProjects, type Project } from "@/lib/specs/projects";
import { ensureStoresOnce } from "@/lib/specs/seed";

const COMPONENT = "specs.pipeline";
/** Depth bound for the item spec-tree walk (see itemStoreChildren). */
const MAX_ITEM_SPEC_DEPTH = 4;
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
//
// Project layer (033): a directory-scanned store's top level now holds Projects
// (project.json-bearing dirs), not features directly. Below a project, arbitrary
// plain sub-folders may nest to any depth for organization; a directory is a
// "feature leaf" iff it directly contains spec.md — that's the only rule used to
// find features, not a fixed depth. `featureId` throughout this file is really
// "the path from the store root to the feature leaf" (e.g. "bos/003-foo" or
// "bos/agent-loop/003-foo"), so numbering is unique per project, not per store —
// never key anything on a bare NNN-slug alone. Item-owned stores (item-stores.ts)
// have no Projects and are untouched by any of this (buildItemSpecification below).

const CONSTITUTION_REL = ".specify/memory/constitution.md";

async function readOr(p: string, fallback = "", ctx?: specfs.SpecCtx): Promise<string> {
  try {
    return await specfs.readFile(p, ctx);
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
  // bos-system-specs is read-only (never editable, branch or not) — no NEW
  // discrepancy can ever be recorded there again, so new entries go to
  // user-specs/discrepancies.md instead. Check both: the system store's copy
  // is a frozen snapshot of whatever was recorded before that changed, not
  // itself retired.
  const [systemDiscrepancies, userDiscrepancies] = await Promise.all([
    sid ? readOr(`${sid}/discrepancies.md`) : Promise.resolve(""),
    readOr("user-specs/discrepancies.md"),
  ]);
  const discrepancies = systemDiscrepancies + userDiscrepancies;

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

/** An item-owned store (item-stores.ts) has no feature-id subfolder — its
 *  root directly holds spec.md/plan.md/etc., because the whole store IS the
 *  one spec that describes that item. Builds the same Specification shape as
 *  buildSpecification(), just addressed by the bare store id. */
async function buildItemSpecification(store: SpecStore, branch?: string): Promise<Specification> {
  const ctx = branch ? { branch } : undefined;
  const artifacts: Artifact[] = (await specfs.listDir(store.id, ctx).catch(() => []))
    .filter((e) => e.type === "file" && e.name.endsWith(".md"))
    .map((e) => ({ name: e.name, path: e.path }));
  const artifactNames = new Set(artifacts.map((a) => a.name));

  const specBody = artifactNames.has("spec.md") ? await readOr(`${store.id}/spec.md`, "", ctx) : "";
  const tasksBody = artifactNames.has("tasks.md") ? await readOr(`${store.id}/tasks.md`, "", ctx) : "";
  const tasks = parseTasks(tasksBody);

  return {
    id: store.id,
    store: store.id,
    title: titleFromSpec(specBody, store.label),
    path: store.id,
    artifacts: artifacts.sort(byArtifactOrder),
    phases: await derivePhases(store.id, store.id, artifactNames),
    taskProgress: tasks.length ? { done: tasks.filter((t) => t.done).length, total: tasks.length } : undefined,
  };
}

function byArtifactOrder(a: Artifact, b: Artifact): number {
  const order = ARTIFACT_FILES as readonly string[];
  const ia = order.indexOf(a.name);
  const ib = order.indexOf(b.name);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.name.localeCompare(b.name);
}

/** Recursively collect feature-leaf paths (store-relative, e.g.
 *  "bos/agent-loop/003-foo") under `relPath`. A leaf is a directory that
 *  directly contains spec.md; recursion stops there (a feature's own
 *  sub-content, like a nested skills/ folder, is never itself walked for
 *  further leaves — the presence of spec.md wins). */
async function walkFeatureLeaves(storeId: string, relPath: string): Promise<string[]> {
  const entries = await specfs.listDir(`${storeId}/${relPath}`).catch(() => []);
  if (entries.some((e) => e.type === "file" && e.name === "spec.md")) return [relPath];
  const out: string[] = [];
  for (const e of entries) {
    if (e.type === "dir") out.push(...(await walkFeatureLeaves(storeId, `${relPath}/${e.name}`)));
  }
  return out;
}

/** Recursively build a project's (or a plain sub-folder's) tree node. Stops
 *  and returns a "feature" node the moment a directory directly contains
 *  spec.md; otherwise keeps descending as a "dir" node. */
async function buildFolderNode(storeId: string, relPath: string, name: string): Promise<SpecTreeNode> {
  const entries = await specfs.listDir(`${storeId}/${relPath}`).catch(() => []);
  if (entries.some((e) => e.type === "file" && e.name === "spec.md")) {
    const files: SpecTreeNode[] = entries
      .filter((e) => e.type === "file")
      .map((e) => ({ type: "file", name: e.name, path: e.path }));
    return { type: "feature", name, path: `${storeId}/${relPath}`, children: files };
  }
  const children: SpecTreeNode[] = [];
  for (const e of entries) {
    if (e.type === "dir") children.push(await buildFolderNode(storeId, `${relPath}/${e.name}`, e.name));
    else children.push({ type: "file", name: e.name, path: e.path });
  }
  return { type: "dir", name, path: `${storeId}/${relPath}`, children };
}

async function buildProjectNode(storeId: string, project: Project): Promise<SpecTreeNode> {
  // Match the "group" node convention: `name` is the directory segment (id),
  // `label` is the human display text — not the same field. A Project is a
  // pure organizational folder — it has no independent activation state of
  // its own (that retired mechanism was 037-project-layer's lightweight
  // per-Project git flow); whether its store is currently writable is a
  // whole-store concern (a real `bos/*` feature branch for user-specs,
  // always false for bos-system-specs), not tracked per node here.
  const node = await buildFolderNode(storeId, project.id, project.id);
  return {
    ...node,
    type: "project",
    label: project.label,
    description: project.description,
  };
}

/** The path segment (project/dir id, not display label) a tree node was built
 *  from — used to match an existing base-side node when grafting a draft-only
 *  branch feature into the tree at the right nesting. */
function segmentIdOf(node: SpecTreeNode, storeId: string): string {
  const rel = node.path.startsWith(`${storeId}/`) ? node.path.slice(storeId.length + 1) : node.path;
  return rel.split("/").pop() ?? rel;
}

/** Graft a draft-only feature leaf into `children` at the nesting implied by
 *  `segments` (a store-relative path split on "/"), creating synthetic "dir"
 *  nodes for any intermediate segment not already present on base (e.g. a
 *  project or sub-folder that only exists on the draft branch so far). */
function insertAtPath(children: SpecTreeNode[], storeId: string, prefix: string[], segments: string[], leaf: SpecTreeNode): void {
  const [head, ...rest] = segments;
  if (!head) return;
  const here = [...prefix, head];
  if (rest.length === 0) {
    // A feature already on base at this exact path (same `leaf.path`) must be
    // REPLACED, not duplicated — a leftover/still-diffing draft branch for a
    // feature that's already on base (e.g. a stale bos/* branch never deleted
    // after its own promote) would otherwise graft a second sibling node with
    // an identical path, which both duplicates the sidebar entry and gives
    // React two siblings with the same key (selection then targets whichever
    // one React's reconciler matches first, not the one actually clicked).
    const idx = children.findIndex((c) => c.path === leaf.path);
    if (idx !== -1) children[idx] = leaf;
    else children.push(leaf);
    return;
  }
  let node = children.find((c) => (c.type === "project" || c.type === "dir") && segmentIdOf(c, storeId) === head);
  if (!node) {
    node = { type: "dir", name: head, path: `${storeId}/${here.join("/")}`, children: [] };
    children.push(node);
  }
  node.children = node.children ?? [];
  insertAtPath(node.children, storeId, here, rest, leaf);
}

/** For a store's draft `bos/*` branches: map each changed file to its nearest
 *  ancestor feature leaf (a dir directly containing spec.md on that branch),
 *  since a changed file's first path segment is a Project id now, not a
 *  feature id. Returns store-relative feature-leaf paths, deduped. */
async function touchedFeaturesOnBranch(storeRoot: string, branch: string): Promise<Set<string>> {
  const changed = await draftChangedFiles(storeRoot, branch).catch(() => [] as string[]);
  const allFiles = await listAllBranchFiles(storeRoot, branch).catch(() => [] as string[]);
  const leafDirs = new Set(allFiles.filter((f) => f.endsWith("/spec.md")).map((f) => f.slice(0, -"/spec.md".length)));
  const touched = new Set<string>();
  for (const rel of changed) {
    const parts = rel.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const candidate = parts.slice(0, i).join("/");
      if (leafDirs.has(candidate)) {
        touched.add(candidate);
        break;
      }
    }
  }
  return touched;
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
export async function listSpecifications(branch?: string): Promise<Specification[]> {
  await ensureStoresOnce();
  constitutionReady = undefined; // re-evaluate per request
  const specs: Specification[] = [];
  for (const store of await listStores()) {
    if (store.owner === "item") {
      // Read through the active branch, same as specTree — an item store's
      // artifacts live in the branch-coupled worktree, so an unbranched read
      // reports base's stale titles and phase state.
      specs.push(await buildItemSpecification(store, branch));
      continue;
    }
    for (const project of await listProjects(store.id)) {
      for (const featurePath of await walkFeatureLeaves(store.id, project.id)) {
        specs.push(await buildSpecification(store.id, featurePath));
      }
    }
    for (const branch of await listDraftBranches(store.root).catch(() => [] as string[])) {
      const touched = await touchedFeaturesOnBranch(store.root, branch);
      for (const featurePath of touched) {
        const files = (await listBranchDirFiles(store.root, branch, featurePath).catch(() => [] as string[])).map((rel) => `${store.id}/${rel}`);
        specs.push(await buildSpecification(store.id, featurePath, { branch, files }));
      }
    }
  }
  return specs.sort((a, b) => (a.store === b.store ? a.id.localeCompare(b.id) : a.store.localeCompare(b.store)));
}

/** Fetch one specification by its store-prefixed path
 *  `<storeId>/<projectId>/.../<NNN-slug>`. Falls back to a draft `bos/*`
 *  branch (020) when the feature has no base copy — same reason as
 *  listSpecifications' fallback above. */
export async function getSpecification(fullPath: string): Promise<Specification | undefined> {
  const safe = fullPath.replace(/[^a-zA-Z0-9._/-]/g, "");
  const [storeId, ...rest] = safe.split("/");
  if (!storeId) return undefined;
  constitutionReady = undefined;
  const id = rest.join("/");
  if (!id) {
    // A bare store id addresses an item-owned store's one implicit feature —
    // every other store requires a `<storeId>/<projectId>/.../<featureId>` path.
    const store = (await listStores()).find((s) => s.id === storeId);
    return store?.owner === "item" ? buildItemSpecification(store) : undefined;
  }
  if (await specfs.exists(`${storeId}/${id}`)) return buildSpecification(storeId, id);

  const store = (await listStores()).find((s) => s.id === storeId);
  if (!store) return undefined;
  for (const branch of await listDraftBranches(store.root).catch(() => [] as string[])) {
    const files = (await listBranchDirFiles(store.root, branch, id).catch(() => [] as string[])).map((rel) => `${storeId}/${rel}`);
    if (files.length > 0) return buildSpecification(storeId, id, { branch, files });
  }
  return undefined;
}

/** Sort every level of a tree by display label — `listDir`/`listProjects`
 *  return filesystem/git-listing order, and the draft-branch overlay above
 *  appends grafted nodes to whatever order `children` was already in, so
 *  neither source is scan-friendly on its own. `label ?? name` sorts a
 *  feature by its raw `NNN-slug` (numeric-ish order, no `label` set) and a
 *  labelled project alphabetically by its human label. Returns new arrays —
 *  doesn't mutate the input, since callers may still hold references to it. */
function sortTreeNodes(nodes: SpecTreeNode[]): SpecTreeNode[] {
  return [...nodes]
    .sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name, undefined, { numeric: true, sensitivity: "base" }))
    .map((n) => (n.children ? { ...n, children: sortTreeNodes(n.children) } : n));
}

/** An item store's artifacts, recursing into sub-folders. An item's `spec/`
 *  folder is a flat feature leaf as far as the pipeline is concerned, but it
 *  routinely contains real sub-directories (`checklists/`, `e2e/`, `contracts/`
 *  — spec-kit's own template layout puts artifacts there). Listing only
 *  top-level files hid every one of them from Build Studio, which read as "this
 *  item has no checklists" rather than "they exist but aren't shown".
 *
 *  `depth` bounds the walk: these are spec folders, not arbitrary trees, and an
 *  unbounded recursion here would follow anything a marketplace item happens to
 *  ship inside `spec/`. Hitting it is logged, never silent — a silently
 *  truncated tree reads as "there is nothing there".
 *
 *  `branch` is the active feature branch, threaded so the listing comes from the
 *  same place writes go.
 *
 *  listDir is deliberately NOT wrapped in a catch: an unreadable spec folder is
 *  a real failure, and swallowing it renders the item as having no artifacts at
 *  all, which is exactly how the item-store history bug stayed invisible. */
async function itemStoreChildren(dir: string, branch?: string, depth = 0): Promise<SpecTreeNode[]> {
  if (depth > MAX_ITEM_SPEC_DEPTH) {
    logger().warn(COMPONENT, "item spec tree truncated at max depth", { dir, depth: MAX_ITEM_SPEC_DEPTH });
    return [];
  }
  const entries = await specfs.listDir(dir, branch ? { branch } : undefined);
  const out: SpecTreeNode[] = [];
  for (const e of entries) {
    if (e.type === "file") {
      out.push({ type: "file", name: e.name, path: e.path });
    } else {
      out.push({ type: "dir", name: e.name, path: e.path, children: await itemStoreChildren(e.path, branch, depth + 1) });
    }
  }
  return sortTreeNodes(out);
}

/** Every store as a group node (Projects -> arbitrary sub-folders -> feature
 *  leaves -> files, or an item store's single synthetic feature). */
export async function specTree(branch?: string): Promise<SpecTreeNode[]> {
  await ensureStoresOnce();
  const groups: SpecTreeNode[] = [];
  for (const store of await listStores()) {
    if (store.owner === "item") {
      // An item store's artifacts live in the branch-coupled `user-apps`
      // worktree, so the tree MUST be read through the same branch its writes
      // go to. Reading it unbranched showed base's copy — stale sizes and a
      // missing/older file list — while every write landed on the branch.
      const files = await itemStoreChildren(store.id, branch);
      groups.push({
        type: "group",
        name: store.id,
        label: store.label,
        path: store.id,
        owner: store.owner,
        writable: store.writable,
        requiresPromote: store.requiresPromote,
        originLabel: store.originLabel,
        children: sortTreeNodes([{ type: "feature", name: store.label, path: store.id, children: files }]),
      });
      continue;
    }
    const children: SpecTreeNode[] = [];
    for (const project of await listProjects(store.id)) {
      children.push(await buildProjectNode(store.id, project));
    }
    // Draft branches (020): features being worked on `bos/*` store branches,
    // rendered read-only from base without any checkout or preview. Grafted
    // into the tree at their real nesting (project + any sub-folders), which
    // may not exist on base yet if the project itself is draft-only so far.
    for (const branch of await listDraftBranches(store.root).catch(() => [] as string[])) {
      const touched = await touchedFeaturesOnBranch(store.root, branch);
      for (const featurePath of touched) {
        const all = await listBranchDirFiles(store.root, branch, featurePath).catch(() => [] as string[]);
        const parts = featurePath.split("/");
        const files: SpecTreeNode[] = all.map((rel) => ({
          type: "file",
          name: rel.split("/").slice(parts.length).join("/") || (rel.split("/").pop() ?? rel),
          path: `${store.id}/${rel}`,
          branch,
        }));
        const leaf: SpecTreeNode = { type: "feature", name: parts[parts.length - 1], path: `${store.id}/${featurePath}`, branch, children: files };
        insertAtPath(children, store.id, [], parts, leaf);
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
      children: sortTreeNodes(children),
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

/** Next spec-kit feature id WITHIN A PROJECT: `NNN-slug`, NNN = max existing +
 *  1 across that project's whole subtree (not the store's, and not
 *  top-level-only — numbering is per-project since 033). `projectPath` is
 *  `<storeId>/<projectId>[/<subfolder>...]`; the new feature is created
 *  directly under it. Returns `<projectPath>/<NNN-slug>`. */
export async function nextFeatureId(name: string, projectPath: string): Promise<string> {
  await ensureStoresOnce();
  const [storeId, ...projRest] = projectPath.split("/");
  const store = (await listStores()).find((s) => s.id === storeId);
  if (!store) throw new Error(`Unknown spec store "${storeId}".`);
  if (store.owner === "item") {
    throw new Error(`Store "${store.id}" is an item-owned spec store — it can only ever hold that item's one spec.`);
  }
  const projRel = projRest.join("/");
  if (!projRel) throw new Error(`nextFeatureId requires a project path, e.g. "${storeId}/<projectId>".`);

  const leaves = await walkFeatureLeaves(storeId, projRel).catch(() => [] as string[]);
  let max = 0;
  for (const leaf of leaves) {
    const m = (leaf.split("/").pop() ?? "").match(/^(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const topEntries = await specfs.listDir(`${storeId}/${projRel}`).catch(() => []);
  const taken = new Set(topEntries.filter((e) => e.type === "dir").map((e) => e.name));

  const num = String(max + 1).padStart(3, "0");
  const slug = slugify(name);
  let id = `${num}-${slug}`;
  let suffix = 2;
  while (taken.has(id)) id = `${num}-${slug}-${suffix++}`;
  return `${storeId}/${projRel}/${id}`;
}
