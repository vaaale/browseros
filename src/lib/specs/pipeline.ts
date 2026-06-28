import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import {
  ARTIFACT_FILES,
  type Artifact,
  type PhaseId,
  type PipelinePhase,
  type Specification,
  type SpecTreeNode,
  type Task,
} from "./types";

const CONSTITUTION = ".specify/memory/constitution.md";

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

let constitutionReady: boolean | undefined;
async function hasConstitution(): Promise<boolean> {
  if (constitutionReady !== undefined) return constitutionReady;
  const body = await readOr(CONSTITUTION);
  // "Ready" = present and not the placeholder template (which is full of [TOKENS]).
  constitutionReady = body.length > 0 && !body.includes("[PROJECT_NAME]");
  return constitutionReady;
}

async function derivePhases(featurePath: string, artifactNames: Set<string>): Promise<PipelinePhase[]> {
  const spec = artifactNames.has("spec.md") ? await readOr(`${featurePath}/spec.md`) : "";
  const tasksBody = artifactNames.has("tasks.md") ? await readOr(`${featurePath}/tasks.md`) : "";
  const tasks = parseTasks(tasksBody);
  const done = tasks.filter((t) => t.done).length;
  const discrepancies = await readOr("specs/discrepancies.md");

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
    phase("converge", discrepancies.includes(featurePath.replace(/^specs\//, "")) ? "done" : "na"),
  ];
}

async function buildSpecification(id: string): Promise<Specification> {
  const featurePath = `specs/${id}`;
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
    title: titleFromSpec(specBody, id),
    path: featurePath,
    artifacts: artifacts.sort(byArtifactOrder),
    phases: await derivePhases(featurePath, artifactNames),
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

/** All feature folders under specs/, each with derived pipeline status. */
export async function listSpecifications(): Promise<Specification[]> {
  constitutionReady = undefined; // re-evaluate per request
  const top = await specfs.listDir("specs").catch(() => []);
  const features = top.filter((e) => e.type === "dir");
  const specs: Specification[] = [];
  for (const f of features) specs.push(await buildSpecification(f.name));
  return specs.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getSpecification(id: string): Promise<Specification | undefined> {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || !(await specfs.exists(`specs/${safe}`))) return undefined;
  constitutionReady = undefined;
  return buildSpecification(safe);
}

/** specs/ as a tree (feature folders flagged), for the app's left panel. */
export async function specTree(): Promise<SpecTreeNode[]> {
  const top = await specfs.listDir("specs").catch(() => []);
  const nodes: SpecTreeNode[] = [];
  for (const e of top) {
    if (e.type === "dir") {
      const children = (await specfs.listDir(e.path).catch(() => []))
        .filter((c) => c.type === "file")
        .map<SpecTreeNode>((c) => ({ type: "file", name: c.name, path: c.path }));
      nodes.push({ type: "feature", name: e.name, path: e.path, children });
    } else {
      nodes.push({ type: "file", name: e.name, path: e.path });
    }
  }
  return nodes;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "feature";
}

/** Next spec-kit feature id: `NNN-slug`, where NNN = max existing + 1. */
export async function nextFeatureId(name: string): Promise<string> {
  const top = await specfs.listDir("specs").catch(() => []);
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
  return id;
}
