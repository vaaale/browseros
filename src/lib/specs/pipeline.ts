import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import { listStores } from "@/lib/specs/stores";
import { hasCandidate } from "@/lib/specs/store-git";
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
): Promise<PipelinePhase[]> {
  const spec = artifactNames.has("spec.md") ? await readOr(`${featurePath}/spec.md`) : "";
  const tasksBody = artifactNames.has("tasks.md") ? await readOr(`${featurePath}/tasks.md`) : "";
  const tasks = parseTasks(tasksBody);
  const done = tasks.filter((t) => t.done).length;
  const sid = await systemStoreId();
  const discrepancies = sid ? await readOr(`${sid}/discrepancies.md`) : "";

  const phase = (id: PhaseId, state: PipelinePhase["state"]): PipelinePhase => ({ id, state });

  let implementState: PipelinePhase["state"] = "na";
  if (tasks.length > 0) implementState = done === tasks.length ? "done" : done > 0 ? "pending" : "na";

  return [
    phase("constitution", (await hasConstitution()) ? "done" : "pending"),
    phase("specify", artifactNames.has("spec.md") ? "done" : "pending"),
    phase("clarify", spec.includes("## Clarifications") ? "done" : artifactNames.has("spec.md") ? "pending" : "na"),
    phase("plan", artifactNames.has("plan.md") ? "done" : artifactNames.has("spec.md") ? "pending" : "na"),
    phase("tasks", artifactNames.has("tasks.md") ? "done" : artifactNames.has("plan.md") ? "pending" : "na"),
    phase("analyze", "na"),
    phase("implement", implementState),
    phase("converge", discrepancies.includes(featureId) ? "done" : "na"),
  ];
}

async function buildSpecification(storeId: string, id: string): Promise<Specification> {
  const featurePath = `${storeId}/${id}`;
  const entries = await specfs.listDir(featurePath).catch(() => []);
  const artifacts: Artifact[] = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".md"))
    .map((e) => ({ name: e.name, path: e.path }));
  const artifactNames = new Set(artifacts.map((a) => a.name));

  const specBody = artifactNames.has("spec.md") ? await readOr(`${featurePath}/spec.md`) : "";
  const tasksBody = artifactNames.has("tasks.md") ? await readOr(`${featurePath}/tasks.md`) : "";
  const tasks = parseTasks(tasksBody);

  return {
    id,
    store: storeId,
    title: titleFromSpec(specBody, id),
    path: featurePath,
    artifacts: artifacts.sort(byArtifactOrder),
    phases: await derivePhases(featurePath, id, artifactNames),
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

/** All feature folders across all stores, each with derived pipeline status. */
export async function listSpecifications(): Promise<Specification[]> {
  await ensureStoresOnce();
  constitutionReady = undefined; // re-evaluate per request
  const specs: Specification[] = [];
  for (const store of await listStores()) {
    const top = await specfs.listDir(store.id).catch(() => []);
    for (const f of top.filter((e) => e.type === "dir")) {
      specs.push(await buildSpecification(store.id, f.name));
    }
  }
  return specs.sort((a, b) => (a.store === b.store ? a.id.localeCompare(b.id) : a.store.localeCompare(b.store)));
}

/** Fetch one specification by its store-prefixed path `<storeId>/<featureId>`. */
export async function getSpecification(fullPath: string): Promise<Specification | undefined> {
  const safe = fullPath.replace(/[^a-zA-Z0-9._/-]/g, "");
  const [storeId, id] = safe.split("/");
  if (!storeId || !id) return undefined;
  if (!(await specfs.exists(`${storeId}/${id}`))) return undefined;
  constitutionReady = undefined;
  return buildSpecification(storeId, id);
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
    groups.push({
      type: "group",
      name: store.id,
      label: store.label,
      path: store.id,
      owner: store.owner,
      writable: store.writable,
      requiresPromote: store.requiresPromote,
      hasCandidate: store.requiresPromote ? await hasCandidate(store.root) : false,
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
