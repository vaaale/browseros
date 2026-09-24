import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import { UserAppsNotCoupled } from "@/lib/dev/spec-fs";
import { getBranchScope } from "@/lib/specs/branch-scope";
import { ITEM_STORE_PREFIX } from "@/lib/specs/item-stores";
import { logger } from "@/lib/logging/server-logger";
import { listStores, type SpecStore } from "@/lib/specs/stores";
import { listDraftBranches, draftChangedFiles, listBranchDirFiles, listAllBranchFiles } from "@/lib/specs/store-git";
import { listProjects, type Project } from "@/lib/specs/projects";
import { ensureStoresOnce } from "@/lib/specs/seed";

const COMPONENT = "specs.pipeline";
/** Depth bound for the item spec-tree walk (see itemStoreChildren). */
const MAX_ITEM_SPEC_DEPTH = 4;
import {
  type Artifact,
  type PipelinePhase,
  type Specification,
  type SpecTreeNode,
} from "./types";
import { parseTasks } from "./tasks";
import { isLeafListing, leafDirsFromPaths, leafMarkerFor, sectionFor } from "./leaf";
import { bindingScopeOf, projectsAre, honoursProjectBinding } from "./store-kind";
import { evaluatePhases, globMatches, type EvalUnit } from "./method/evaluate";
import { resolveMethod } from "./method/resolve";
import { toMethodSummary, type MethodDescriptor, type MethodSummary, type SectionSpec, type StoreRoot } from "./method/types";

export { parseTasks };

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

async function readOr(p: string, fallback = "", ctx?: specfs.SpecCtx): Promise<string> {
  try {
    return await specfs.readFile(p, ctx);
  } catch {
    return fallback;
  }
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

/** Per-request cache for STORE-scoped reads (the constitution, discrepancies).
 *
 *  Both are read once per feature by the rule evaluator, and a request lists
 *  every feature in every store — 132 of them on a real deployment. The old
 *  code memoized the constitution in a single module global (`constitutionReady`)
 *  reset per request; this is the same lifetime, generalized to any store-scoped
 *  path, because the descriptor can name others. */
let storeReadCache = new Map<string, Promise<string>>();
const methodCache = new Map<string, Promise<MethodDescriptor>>();

/** Both caches last ONE call into this module, no longer.
 *
 *  `methodCache` memoises a store's descriptor so listing 143 features resolves
 *  it once instead of 143 times. But it is a module global, and a module global
 *  in a long-lived server outlives the binding it caches: change a store's
 *  method and every entry point that does not clear this keeps serving the OLD
 *  descriptor until something else happens to clear it.
 *
 *  That is not hypothetical. `nextFeatureId` and `specTree` did not clear it, so
 *  a store rebound from a `numbering: "none"` method kept allocating unnumbered
 *  ids — and the same staleness surfaced in the suite as a test that failed only
 *  when it shared a worker with one that bound a different method.
 *
 *  EVERY public entry point must call this first. A new one that forgets
 *  reintroduces exactly this bug, silently. */
function resetStoreReadCache(): void {
  storeReadCache = new Map();
  methodCache.clear();
}

/** Resolve a descriptor's StoreRoot list to concrete store ids, then read and
 *  concatenate. `system` is whichever store owns system artifacts; `user` is
 *  the literal `user-specs` (spec-kit's converge reads it for features in every
 *  store — FR-006a's explicit exception, declared in the descriptor). */
async function readStoreScoped(rel: string, roots: StoreRoot[], ownStoreId: string): Promise<string> {
  const key = `${ownStoreId}|${roots.join(",")}|${rel}`;
  const hit = storeReadCache.get(key);
  if (hit) return hit;
  const run = (async () => {
    const ids: string[] = [];
    for (const root of roots) {
      if (root === "own") ids.push(ownStoreId);
      else if (root === "user") ids.push("user-specs");
      else {
        const sid = await systemStoreId();
        if (sid) ids.push(sid);
      }
    }
    const bodies = await Promise.all([...new Set(ids)].map((id) => readOr(`${id}/${rel}`)));
    return bodies.join("");
  })();
  storeReadCache.set(key, run);
  return run;
}

/** Resolve the phases for one unit through the active descriptor's rules.
 *
 *  Replaces derivePhases' if/else ladder (was pipeline.ts:106-124). Every
 *  branch of that ladder now lives in spec-kit.ts as an ordered clause list;
 *  tests/specs/method-parity.test.ts is what asserts the translation is
 *  faithful, and it was captured BEFORE this edit for exactly that reason. */
/** Every file under a store-prefixed directory, as paths RELATIVE to it,
 *  including nested ones.
 *
 *  `set`/`count` predicates exist for artifacts whose cardinality is unknown
 *  when the descriptor is written — BMAD's sharded stories (`stories/*.md`),
 *  OpenSpec's delta specs (`specs/**` + `/*.md`). Those files are NESTED inside
 *  a unit, so the unit's top-level artifact listing can never match them. */
async function listFilesUnder(prefix: string, rel = ""): Promise<string[]> {
  const entries = await specfs.listDir(rel ? `${prefix}/${rel}` : prefix).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.type === "dir") out.push(...(await listFilesUnder(prefix, next)));
    else out.push(next);
  }
  return out;
}

async function derivePhases(
  descriptor: MethodDescriptor,
  storeId: string,
  featurePath: string,
  featureId: string,
  artifactNames: Set<string>,
  branch?: string,
  /** Every file in the unit, nested ones included, relative to the unit. */
  unitFiles?: string[],
): Promise<PipelinePhase[]> {
  // Draft-branch content (020) is read at the branch, not base — a spec being
  // actively written on a feature branch has no base copy to fall back to.
  const readUnit = (rel: string) =>
    branch ? specfs.readFileAt(`${featurePath}/${rel}`, branch).catch(() => "") : readOr(`${featurePath}/${rel}`);

  // A unit in a TERMINAL section is finished by definition, so the DAG must not
  // be evaluated against it — an archived OpenSpec change would otherwise report
  // "tasks: available" for work completed months ago, inviting someone to edit
  // frozen history believing it is open work (047 FR-006b). `terminal` was
  // declared in the descriptor from the start and read by nothing; this is where
  // it becomes real.
  const section = sectionFor(descriptor, featureId);
  if (section.terminal) {
    return descriptor.phases.map((phase) => ({ id: phase.id, label: phase.label, state: "na" as const }));
  }

  const unit: EvalUnit = {
    unitId: featureId,
    names: [...artifactNames],
    readUnit,
    readStore: (rel, roots) => readStoreScoped(rel, roots, storeId),
    // Without this, `set`/`count` fall back to matching the unit's TOP-LEVEL
    // artifact names — which nested paths like `stories/003-login.md` can never
    // match, so every glob predicate silently evaluates to "no files". The
    // predicate's own unit tests supplied a globber of their own and so could
    // not see it: they exercised the evaluator, not the pipeline that feeds it.
    glob: async (pattern, scope) => {
      const files = scope === "store" ? await listFilesUnder(storeId) : (unitFiles ?? [...artifactNames]);
      return files.filter((f) => globMatches(pattern, f));
    },
  };
  return evaluatePhases(descriptor, unit);
}

/** Refuse a user edit to content its method declares FROZEN (047 FR-009).
 *
 *  `terminal` already stops BOS evaluating the phase DAG against archived units.
 *  That is a display concern; this is the correctness one. An archived OpenSpec
 *  change is the record of what was decided — editing it rewrites history that
 *  other specs were merged from, and nothing would report it.
 *
 *  Enforced at the USER-FACING seams (the API routes and the spec-writing tool)
 *  rather than inside spec-fs, deliberately: BOS itself must retain write access
 *  to these paths. Seeding writes a store root, and the archive operation this
 *  feature defers (FR-009's non-requirement) must be able to MOVE a change into
 *  the archive. A blanket jail in spec-fs would make that unimplementable and
 *  would be discovered only when someone tried to build it.
 *
 *  Throws rather than returning a boolean: every caller here is a mutation, and
 *  a guard whose result can be ignored is not a guard. */
export async function assertEditablePath(fullPath: string): Promise<void> {
  // A public entry point, so it resets — see resetStoreReadCache. I added this
  // function three commits after writing that invariant and still forgot it,
  // which is the point: the rule is unenforceable by types, so the only thing
  // standing between it and a stale descriptor is someone reading the comment.
  resetStoreReadCache();
  const safe = fullPath.replace(/[^a-zA-Z0-9._/-]/g, "");
  const [storeId, ...rest] = safe.split("/");
  if (!storeId || rest.length === 0) return;
  const descriptor = await methodForOrNull(storeId);
  if (!descriptor) return; // an unresolvable method is FR-016's error, not this one
  const section = sectionFor(descriptor, rest.join("/"));
  if (!section.terminal) return;
  const what = section.terminalLabel ?? "Archived";
  throw new Error(
    `"${fullPath}" is in the ${what.toLowerCase()} section "${section.rel}" and is read-only. ` +
      `${descriptor.label} treats it as a finished record; change the active work instead, or move it out with that framework's own tooling.`,
  );
}

/** THE way to ask what method governs a store, or a project within it.
 *
 *  Every caller outside this module uses this. `resolveMethod` is the pure
 *  chain primitive underneath, and it takes a binding the CALLER assembles —
 *  which is how three call sites came to assemble it differently: one omitted
 *  the global default, one omitted the project, and none read `workflow`. Each
 *  was individually reasonable, and together they meant BOS resolved a
 *  different method depending on which code path you arrived through.
 *
 *  If you are reaching for `resolveMethod` outside this file, you want this. */
export async function methodForStore(storeId: string, projectId?: string, branch?: string): Promise<MethodDescriptor> {
  resetStoreReadCache(); // public entry point — see resetStoreReadCache
  return methodFor(storeId, projectId, branch);
}

/** The method a thing that does not exist YET would get — a new item, before
 *  there is a store to resolve against. The global default and nothing else,
 *  because there is no store or project binding to consult. */
export async function defaultMethod(): Promise<MethodDescriptor> {
  resetStoreReadCache();
  return resolveMethod({ globalDefault: await globalDefaultMethod() }, "user-apps");
}

/** The descriptor for a store, or `undefined` when it cannot be resolved.
 *
 *  FR-016 says a store bound to an uninstalled method must render "method not
 *  installed" rather than silently falling back to spec-kit. It does NOT say
 *  that store should take down every OTHER store with it — but that is what a
 *  throw here does, because /api/specs resolves the whole tree in one
 *  Promise.all: one unresolvable binding blanks the entire Build Studio
 *  sidebar, including stores that resolve perfectly well. That failure is
 *  indistinguishable from "my specs are gone".
 *
 *  So: contained per store, logged loudly, and surfaced on the group node. */
async function methodForOrNull(storeId: string, projectId?: string, branch?: string): Promise<MethodDescriptor | undefined> {
  try {
    return await methodFor(storeId, projectId, branch);
  } catch (err) {
    logger().error(COMPONENT, "method resolution failed for store", undefined, {
      storeId,
      error: (err as Error).message,
    });
    return undefined;
  }
}

/** The active descriptor, projected for the client (FR-014 / T028).
 *
 *  Stage A has one method, so "active" is unambiguous. Stage B binds per
 *  store; the summary then describes whichever store the client is looking at.
 *  Returned from GET /api/specs so the client never re-derives phase metadata
 *  — it has no phase vocabulary of its own any more (FR-007). */
export async function activeMethodSummary(): Promise<MethodSummary | undefined> {
  const d = await methodForOrNull("user-specs");
  return d ? toMethodSummary(d) : undefined;
}

/** The descriptor governing a store, or a Project within it (FR-008).
 *
 *  project.json `method` -> spec-store.json `method` -> the user's global
 *  default -> spec-kit. Absent everywhere ⇒ spec-kit, which is what keeps
 *  every existing store behaving exactly as before.
 *
 *  Memoized per request alongside the store-read cache: listSpecifications
 *  resolves this once per store and once per Project, and the global default
 *  is a config read. */
async function methodFor(storeId: string, projectId?: string, branch?: string): Promise<MethodDescriptor> {
  // `branch` is part of the key: the binding is read from the STORE RECORD, and
  // an item created on a branch has no base record at all — resolving it
  // without the branch found no store, therefore no binding, therefore the
  // global default. An app created under BMAD reported spec-kit for exactly
  // this reason, one lookup after the binding was correctly written.
  const key = `${storeId}/${projectId ?? ""}/${branch ?? ""}`;
  const hit = methodCache.get(key);
  if (hit) return hit;
  const run = (async () => {
    // A store may be bound to an installed pack; make sure this module instance
    // knows about it before resolving, or the binding reads as "not installed".
    const { ensureInstalledMethodPacks } = await import("./method/install");
    // NOT swallowed. If registration fails, every binding to an installed pack
    // resolves as "not installed" — and the only symptom was that downstream
    // message, which names the pack but not the reason it is missing. Log the
    // real cause here; resolution still continues so one bad pack cannot make
    // every store unreadable (FR-016's containment).
    await ensureInstalledMethodPacks().catch((err) => {
      logger().error(COMPONENT, "registering installed method packs failed", undefined, {
        storeId,
        error: (err as Error).message,
      });
    });
    const store = (await listStores(branch)).find((s) => s.id === storeId);
    const project = projectId ? (await listProjects(storeId)).find((p) => p.id === projectId) : undefined;

    // 049 FR-011b: a per-PROJECT binding in a store that binds at STORE level
    // is not honoured. REPORT it — silently honouring it would make one folder
    // disagree with the store it lives in, and silently dropping it leaves the
    // user with a binding they can neither see nor act on. Both are how the
    // picker came to be offered where it could never take effect.
    const projectBinding = project?.workflow ?? project?.method;
    const honoured = store ? honoursProjectBinding(store) : true;
    if (projectBinding && !honoured) {
      logger().warn(COMPONENT, "per-project binding ignored: this store binds at store level", {
        storeId,
        projectId,
        binding: projectBinding,
        scope: store ? bindingScopeOf(store) : "unknown",
      });
    }

    return resolveMethod(
      {
        // `workflow` supersedes `method` at every level (049 FR-009). Reading
        // only `method` here meant a store bound BY WORKFLOW resolved as if it
        // were unbound — the field was written and never consulted.
        store: store?.workflow ?? store?.method,
        project: honoured ? projectBinding : undefined,
        globalDefault: await globalDefaultMethod(),
      },
      storeId,
    );
  })();
  methodCache.set(key, run);
  return run;
}

/** The user's global default method. Read through the config registry so the
 *  Settings tab and this resolution can never disagree. A failure here falls
 *  back to spec-kit rather than throwing: an unreadable config must not make
 *  every store unrenderable. */
async function globalDefaultMethod(): Promise<string | undefined> {
  try {
    const { readNamespace } = await import("@/lib/config/store");
    const s = await readNamespace("build-studio");
    const v = s.defaultMethod;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch (err) {
    // Continuing is deliberate — an unreadable config must not make every store
    // unrenderable — but NOT silent. This value is the last link in the binding
    // chain, so losing it silently means every unbound store resolves to
    // spec-kit and looks like it was never bound.
    //
    // It became the only place this is handled when four hand-assembled chains
    // collapsed into one: the caller that used to log this no longer has its
    // own catch, so the shared path has to carry it.
    logger().warn(COMPONENT, "could not read the default method; falling back to spec-kit", {
      error: (err as Error).message,
    });
    return undefined;
  }
}

/** `opts.branch` + `opts.files` (store-prefixed paths, from listBranchDirFiles)
 *  build a Specification purely from a draft `bos/*` branch — used when the
 *  feature doesn't exist on base at all yet (020). Omit both for the normal
 *  base-store case. */
/** Resolve one unit's phases under an ARBITRARY descriptor (051 T025).
 *
 *  Exported as a SEAM, not as a convenience. Answering "what would this gate
 *  block?" means evaluating the same unit twice, once under each descriptor, and
 *  the alternative was for the caller to assemble its own `EvalUnit` — a second
 *  implementation of how the evaluator is fed. That is the divergence this
 *  subsystem keeps producing: `glob` was optional here for exactly that reason
 *  and every caller that omitted it silently matched nothing.
 *
 *  So there is one place that knows how to feed the evaluator, and callers pass
 *  the descriptor they want it fed with. */
export async function evaluateUnitWith(
  descriptor: MethodDescriptor,
  storeId: string,
  featureId: string,
): Promise<PipelinePhase[]> {
  const featurePath = `${storeId}/${featureId}`;
  const artifactNames = new Set(
    (await specfs.listDir(featurePath).catch(() => []))
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .map((e) => e.name),
  );
  return derivePhases(descriptor, storeId, featurePath, featureId, artifactNames, undefined, await listFilesUnder(featurePath));
}

async function buildSpecification(storeId: string, id: string, opts?: { branch?: string; files?: string[] }): Promise<Specification> {
  const descriptor = await methodFor(storeId);
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

  // Nested files too — glob predicates match against these, not just the
  // top-level artifacts. On a draft branch the caller already has the full flat
  // list; strip the unit prefix rather than re-listing a tree that has no base
  // copy to walk.
  const unitFiles = branch
    ? (opts?.files ?? []).map((p) => (p.startsWith(`${featurePath}/`) ? p.slice(featurePath.length + 1) : p))
    : await listFilesUnder(featurePath);

  const read = (rel: string) => (branch ? specfs.readFileAt(`${featurePath}/${rel}`, branch).catch(() => "") : readOr(`${featurePath}/${rel}`));
  // The unit's own section decides its marker: a unit in OpenSpec's `specs/`
  // tree is titled from spec.md, one in `changes/` from proposal.md. Using the
  // first section's marker everywhere left every change untitled.
  const primary = leafMarkerFor(descriptor, id);
  const specBody = artifactNames.has(primary) ? await read(primary) : "";
  const tasksBody = artifactNames.has("tasks.md") ? await read("tasks.md") : "";
  const tasks = parseTasks(tasksBody);

  return {
    id,
    store: storeId,
    title: titleFromSpec(specBody, id),
    path: featurePath,
    artifacts: artifacts.sort(byArtifactOrder(descriptor)),
    phases: await derivePhases(descriptor, storeId, featurePath, id, artifactNames, branch, unitFiles),
    taskProgress: tasks.length ? { done: tasks.filter((t) => t.done).length, total: tasks.length } : undefined,
    ...(branch ? { branch } : {}),
  };
}

/** An item-owned store (item-stores.ts) has no feature-id subfolder — its
 *  root directly holds spec.md/plan.md/etc., because the whole store IS the
 *  one spec that describes that item. Builds the same Specification shape as
 *  buildSpecification(), just addressed by the bare store id. */
async function buildItemSpecification(store: SpecStore, branch?: string): Promise<Specification> {
  // Through the branch: the item's binding lives in its own spec-store.json on
  // that branch, and resolving it from base picks the global default for an
  // item base has never seen — which then names the WRONG primary artifact and
  // reports the spec as empty.
  const descriptor = await methodFor(store.id, undefined, branch);
  let ctx = branch ? { branch } : undefined;
  // Same cause as specTree's item branch: a branch that does not couple
  // user-apps cannot be read through, and the ONE recoverable case falls back
  // to base. The `.catch(() => [])` this replaces caught everything, so an
  // uncoupled branch — and a genuinely broken mount alike — reported the item
  // as having no artifacts at all, which reads as an empty spec rather than as
  // a spec that was never looked for.
  let entries: specfs.SpecEntry[];
  try {
    entries = await specfs.listDir(store.id, ctx);
  } catch (err) {
    if (!(err instanceof UserAppsNotCoupled)) throw err;
    ctx = undefined;
    entries = await specfs.listDir(store.id);
  }
  const artifacts: Artifact[] = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".md"))
    .map((e) => ({ name: e.name, path: e.path }));
  const artifactNames = new Set(artifacts.map((a) => a.name));

  const primary = leafMarkerFor(descriptor);
  const specBody = artifactNames.has(primary) ? await readOr(`${store.id}/${primary}`, "", ctx) : "";
  const tasksBody = artifactNames.has("tasks.md") ? await readOr(`${store.id}/tasks.md`, "", ctx) : "";
  const tasks = parseTasks(tasksBody);

  return {
    id: store.id,
    store: store.id,
    title: titleFromSpec(specBody, store.label),
    path: store.id,
    artifacts: artifacts.sort(byArtifactOrder(descriptor)),
    phases: await derivePhases(descriptor, store.id, store.id, store.id, artifactNames),
    taskProgress: tasks.length ? { done: tasks.filter((t) => t.done).length, total: tasks.length } : undefined,
  };
}

/** Sort a unit's artifacts by the descriptor's declared order.
 *
 *  Names ABSENT from `artifactOrder` all rank 99 and then fall to
 *  localeCompare — preserved exactly, because spec-kit's list omits design.md
 *  and test-results.md, 23 live features carry a design.md, and re-ranking it
 *  changes Specification.artifacts[] which SC-001 requires be identical. */
function byArtifactOrder(descriptor: MethodDescriptor): (a: Artifact, b: Artifact) => number {
  const order = descriptor.artifactOrder;
  return (a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.name.localeCompare(b.name);
  };
}

/** Recursively collect feature-leaf paths (store-relative, e.g.
 *  "bos/agent-loop/003-foo") under `relPath`. A leaf is a directory that
 *  directly contains spec.md; recursion stops there (a feature's own
 *  sub-content, like a nested skills/ folder, is never itself walked for
 *  further leaves — the presence of spec.md wins). */
async function walkFeatureLeaves(storeId: string, relPath: string, descriptor: MethodDescriptor, owner?: SectionSpec): Promise<string[]> {
  // A path owned by a MORE SPECIFIC section belongs to that section's own walk.
  // Without this, OpenSpec's `changes` walk also collects everything under
  // `changes/archive`, and every archived change is discovered twice — once as
  // active work. Single-section descriptors never take this branch.
  if (owner && sectionFor(descriptor, relPath) !== owner) return [];
  const entries = await specfs.listDir(`${storeId}/${relPath}`).catch(() => []);
  if (isLeafListing(entries, descriptor, relPath)) return [relPath];
  const out: string[] = [];
  for (const e of entries) {
    if (e.type === "dir") out.push(...(await walkFeatureLeaves(storeId, `${relPath}/${e.name}`, descriptor, owner)));
  }
  return out;
}

/** Every root a descriptor's units are discovered under, paired with the
 *  section that owns it.
 *
 *  A `rel: ""` section means "the store root is organised into BOS Projects" —
 *  spec-kit and BMAD. A section with a `rel` owns that subtree directly and has
 *  no Projects in it: OpenSpec's `changes/add-dark-mode` is a unit, not a
 *  Project containing units. Both shapes exist in one store, so discovery walks
 *  SECTIONS and lets each decide. preflight.ts made this distinction from the
 *  start; discovery did not, which is why a store bound to OpenSpec rendered
 *  empty. */
async function discoveryRoots(storeId: string, descriptor: MethodDescriptor): Promise<{ rel: string; section: SectionSpec }[]> {
  const roots: { rel: string; section: SectionSpec }[] = [];
  for (const section of descriptor.sections) {
    if (section.rel) {
      roots.push({ rel: section.rel, section });
      continue;
    }
    for (const project of await listProjects(storeId)) roots.push({ rel: project.id, section });
  }
  return roots;
}

/** Recursively build a project's (or a plain sub-folder's) tree node. Stops
 *  and returns a "feature" node the moment a directory directly contains
 *  spec.md; otherwise keeps descending as a "dir" node. */
async function buildFolderNode(storeId: string, relPath: string, name: string, descriptor: MethodDescriptor): Promise<SpecTreeNode> {
  const entries = await specfs.listDir(`${storeId}/${relPath}`).catch(() => []);
  // Tag a node that IS a section root, wherever it sits. Done here rather than
  // at the call site so a NESTED section (OpenSpec's `changes/archive`, which
  // renders inside `changes`) is labelled by the same rule as a top-level one.
  const own = descriptor.sections.find((s) => s.rel && s.rel === relPath);
  // `terminal` is resolved for EVERY node, not just a section root: the client
  // asks "may I edit this file", and a unit five levels inside an archive is as
  // frozen as the folder naming it. `sectionKind` stays on the root alone so the
  // badge marks the boundary rather than every row beneath it.
  const frozen = sectionFor(descriptor, relPath).terminal === true;
  const tag = {
    ...(own ? { sectionKind: own.kind } : {}),
    ...(frozen ? { terminal: true as const } : {}),
  };

  if (isLeafListing(entries, descriptor, relPath)) {
    const files: SpecTreeNode[] = entries
      .filter((e) => e.type === "file")
      .map((e) => ({ type: "file", name: e.name, path: e.path }));
    return { type: "feature", name, path: `${storeId}/${relPath}`, ...tag, children: files };
  }
  const children: SpecTreeNode[] = [];
  for (const e of entries) {
    if (e.type === "dir") children.push(await buildFolderNode(storeId, `${relPath}/${e.name}`, e.name, descriptor));
    else children.push({ type: "file", name: e.name, path: e.path });
  }
  return { type: "dir", name, path: `${storeId}/${relPath}`, ...tag, children };
}

async function buildProjectNode(storeId: string, project: Project, descriptor: MethodDescriptor): Promise<SpecTreeNode> {
  // Match the "group" node convention: `name` is the directory segment (id),
  // `label` is the human display text — not the same field. A Project is a
  // pure organizational folder — it has no independent activation state of
  // its own (that retired mechanism was 037-project-layer's lightweight
  // per-Project git flow); whether its store is currently writable is a
  // whole-store concern (a real `bos/*` feature branch for user-specs,
  // always false for bos-system-specs), not tracked per node here.
  // A Project may override its store's method (FR-008), so its children must be
  // walked with the descriptor that governs THEM — the store's leaf marker would
  // otherwise decide where a differently-bound Project's features end.
  const own = project.method ? await methodForOrNull(storeId, project.id) : null;
  const effective = own ?? descriptor;
  const node = await buildFolderNode(storeId, project.id, project.id, effective);
  return {
    ...node,
    type: "project",
    label: project.label,
    description: project.description,
    method: effective.id,
    methodBound: !!(project.workflow ?? project.method),
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
async function touchedFeaturesOnBranch(storeRoot: string, branch: string, descriptor: MethodDescriptor): Promise<Set<string>> {
  const changed = await draftChangedFiles(storeRoot, branch).catch(() => [] as string[]);
  const allFiles = await listAllBranchFiles(storeRoot, branch).catch(() => [] as string[]);
  const leafDirs = leafDirsFromPaths(allFiles, descriptor);
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
  resetStoreReadCache(); // re-evaluate constitution/discrepancies per request
  const specs: Specification[] = [];
  // Through the branch: an app created on it has no base listing to be found
  // in, and listing base only is exactly why a new app was invisible.
  for (const store of await listStores(branch)) {
    if (store.owner === "item") {
      // Read through the active branch, same as specTree — an item store's
      // artifacts live in the branch-coupled worktree, so an unbranched read
      // reports base's stale titles and phase state.
      specs.push(await buildItemSpecification(store, branch));
      continue;
    }
    const descriptor = await methodForOrNull(store.id);
    // An unresolvable method means we cannot say what a unit even IS in this
    // store, so it contributes no specifications — but the others still do.
    if (!descriptor) continue;
    for (const { rel, section } of await discoveryRoots(store.id, descriptor)) {
      for (const featurePath of await walkFeatureLeaves(store.id, rel, descriptor, section)) {
        specs.push(await buildSpecification(store.id, featurePath));
      }
    }
    for (const branch of await listDraftBranches(store.root).catch(() => [] as string[])) {
      const touched = await touchedFeaturesOnBranch(store.root, branch, descriptor);
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
  resetStoreReadCache();
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
  resetStoreReadCache(); // a rebound store must not render through its old descriptor
  // WHICH item this branch is for. Every marketplace item lives in the SAME
  // user-apps repo, so "is this store on the branch" is true of all of them at
  // once and cannot distinguish the one being worked on — eleven rows reported
  // the branch for a change that concerned one, which reads as the branch
  // having been created everywhere all over again.
  //
  // The scope has recorded the item from the start (`itemId`) and nothing read
  // it. Resolved ONCE here, not per store: it is one file read, and doing it in
  // the loop would repeat it for every installed item.
  const scope = branch ? await getBranchScope(branch) : undefined;
  // Tolerant of BOTH shapes on the way in. The route now stores one canonical
  // form, but scope files written before it exist on disk carrying the store id
  // — and prefixing that again produced `item-item-<id>`, which matched nothing
  // and badged nothing. A reader that only understands the shape it prefers
  // turns old data into silence.
  const scopedItemStore =
    scope?.kind === "marketplace-item" && scope.itemId
      ? `${ITEM_STORE_PREFIX}${scope.itemId.startsWith(ITEM_STORE_PREFIX) ? scope.itemId.slice(ITEM_STORE_PREFIX.length) : scope.itemId}`
      : undefined;

  /** Is THIS store coupled to the active branch — i.e. do its edits ride it?
   *
   *  Answered per store because the sidebar could not answer it at all. Its
   *  header badge painted the conversation's branch on every `owner: "user"`
   *  store from client state, which was right while user-specs was the only one
   *  — and 050 made every registered repository `owner: "user"` too, so an
   *  unrelated `police-mcp` advertised "Editable on bos/<feature>" for a branch
   *  it does not contain. One global cannot answer a per-store question.
   *
   *  The rule is the SAME one the Supervisor couples by (coupled-repos.mjs), so
   *  what the tree claims and what git actually holds cannot drift apart:
   *    bos-core          user-specs
   *    marketplace-item  that item's store
   *    repository        that repository
   *  An unscoped branch couples user-specs and user-apps, but cannot say WHICH
   *  item — so it claims user-specs only, rather than every item at once. */
  const storeIsOnBranch = (store: SpecStore): boolean => {
    if (!branch) return false;
    if (store.owner === "system") return false; // read-only; never branched
    switch (scope?.kind) {
      case "marketplace-item":
        return store.id === scopedItemStore;
      case "repository":
        return store.id === scope.repoId;
      case "bos-core":
        return store.id === "user-specs";
      default:
        return store.id === "user-specs";
    }
  };
  const groups: SpecTreeNode[] = [];
  // Through the branch — see listSpecifications. An item that exists ONLY on
  // this branch is the app the user just created; off the branch it is
  // correctly absent, because there it does not exist yet.
  for (const store of await listStores(branch)) {
    if (store.owner === "item") {
      // An item store's artifacts live in the branch-coupled `user-apps`
      // worktree, so the tree MUST be read through the same branch its writes
      // go to. Reading it unbranched showed base's copy — stale sizes and a
      // missing/older file list — while every write landed on the branch.
      // Branch coupling is SCOPED: a bos-core or repository branch does not
      // mount user-apps, and reading an item store through it throws. Falling
      // back to base for that one case keeps the rest of the sidebar alive —
      // and says so on the row, rather than presenting base as the branch.
      let files: SpecTreeNode[];
      let offBranch: string | undefined;
      try {
        files = await itemStoreChildren(store.id, branch);
      } catch (err) {
        if (!(err instanceof UserAppsNotCoupled)) throw err;
        offBranch = `not part of ${branch}`;
        files = await itemStoreChildren(store.id);
      }
      // Only the item the branch is FOR. An unscoped branch, or one with no
      // itemId recorded, genuinely couples user-apps and genuinely cannot say
      // which item — so it says nothing rather than badging all of them or
      // guessing one.
      const liveBranch = branch && !offBranch && store.id === scopedItemStore ? branch : undefined;
      // Resolved ONCE and carried on BOTH the group and its synthetic row. The
      // row is what the sidebar draws (item groups are flattened under a single
      // "User Apps" heading, so the group header never appears) — but a group
      // node that reports no method while its own child reports one is a tree
      // that contradicts itself, and every non-UI reader asking "what method is
      // this store on" would get undefined for items only.
      const itemMethod = (await methodForOrNull(store.id, undefined, branch))?.id;
      groups.push({
        type: "group",
        name: store.id,
        label: store.label,
        path: store.id,
        owner: store.owner,
        writable: store.writable,
        requiresPromote: store.requiresPromote,
        originLabel: store.originLabel,
        bindingScope: bindingScopeOf(store),
        projectUnit: projectsAre(store),
        method: itemMethod,
        // The SAME pair the binding chain resolves (`workflow ?? method`) —
        // reading only `method` here reported "inherited the default" for an
        // item that had been explicitly bound, since `workflow` is the key the
        // write side records.
        methodBound: !!(store.workflow ?? store.method),
        ...(liveBranch ? { liveBranch } : {}),
        ...(offBranch ? { offBranch } : {}),
        // The synthetic node IS the item's row in the sidebar (item groups are
        // flattened under one "User Apps" heading, so the group header itself
        // is never drawn). It therefore has to carry the binding, or an item
        // store would have nowhere to hang its method picker.
        children: sortTreeNodes([
          {
            type: "feature",
            name: store.label,
            path: store.id,
            owner: store.owner,
            writable: store.writable,
            method: itemMethod,
            methodBound: !!(store.workflow ?? store.method),
            ...(liveBranch ? { liveBranch } : {}),
            ...(offBranch ? { offBranch } : {}),
            children: files,
          },
        ]),
      });
      continue;
    }
    const descriptor = await methodForOrNull(store.id);
    if (!descriptor) {
      // The store still APPEARS, carrying the reason. A missing group reads as
      // data loss; a present one saying "method not installed" is diagnosable.
      groups.push({
        type: "group",
        name: store.id,
        label: store.label,
        path: store.id,
        owner: store.owner,
        writable: false,
        requiresPromote: store.requiresPromote,
        methodMissing: store.method ?? "unknown",
        children: [],
      });
      continue;
    }
    const children: SpecTreeNode[] = [];
    for (const section of descriptor.sections) {
      if (!section.rel) {
        for (const project of await listProjects(store.id)) {
          children.push(await buildProjectNode(store.id, project, descriptor));
        }
        continue;
      }
      // A section nested inside another already renders within its parent's
      // node — pushing it here too would show every archived change twice.
      const nested = descriptor.sections.some((o) => o !== section && o.rel && section.rel.startsWith(`${o.rel}/`));
      if (nested) continue;
      // Only if it exists: a phantom folder for a section nobody has written to
      // yet reads as content that failed to load.
      if (!(await specfs.exists(`${store.id}/${section.rel}`))) continue;
      children.push(await buildFolderNode(store.id, section.rel, section.rel, descriptor));
    }
    // Draft branches (020): features being worked on `bos/*` store branches,
    // rendered read-only from base without any checkout or preview. Grafted
    // into the tree at their real nesting (project + any sub-folders), which
    // may not exist on base yet if the project itself is draft-only so far.
    for (const branch of await listDraftBranches(store.root).catch(() => [] as string[])) {
      const touched = await touchedFeaturesOnBranch(store.root, branch, descriptor);
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
      method: descriptor.id,
      ...(storeIsOnBranch(store) ? { liveBranch: branch } : {}),
      bindingScope: bindingScopeOf(store),
      projectUnit: projectsAre(store),
      methodBound: !!(store.workflow ?? store.method),
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
  resetStoreReadCache(); // allocate under the store's CURRENT method, not a cached one
  const [storeId, ...projRest] = projectPath.split("/");
  const store = (await listStores()).find((s) => s.id === storeId);
  if (!store) throw new Error(`Unknown spec store "${storeId}".`);
  if (store.owner === "item") {
    throw new Error(`Store "${store.id}" is an item-owned spec store — it can only ever hold that item's one spec.`);
  }
  const projRel = projRest.join("/");
  if (!projRel) throw new Error(`nextFeatureId requires a project path, e.g. "${storeId}/<projectId>".`);

  const descriptor = await methodFor(storeId);
  // The section the new unit will LIVE in, not the first one declared. Under
  // OpenSpec the two coincide only because `changes` happens to be first.
  const section = sectionFor(descriptor, projRel);
  const leaves = await walkFeatureLeaves(storeId, projRel, descriptor).catch(() => [] as string[]);
  let max = 0;
  for (const leaf of leaves) {
    const m = (leaf.split("/").pop() ?? "").match(/^(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const topEntries = await specfs.listDir(`${storeId}/${projRel}`).catch(() => []);
  const taken = new Set(topEntries.filter((e) => e.type === "dir").map((e) => e.name));

  const slug = slugify(name);
  // `numbering: "none"` skips NNN- allocation entirely — OpenSpec names a
  // change by slug alone, and prefixing it would invent an ordering the
  // framework does not have.
  const base = section.numbering === "none" ? slug : `${String(max + 1).padStart(3, "0")}-${slug}`;
  let id = base;
  let suffix = 2;
  while (taken.has(id)) id = `${base}-${suffix++}`;
  return `${storeId}/${projRel}/${id}`;
}
