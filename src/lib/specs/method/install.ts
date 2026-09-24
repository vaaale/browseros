// 045 T024 — installing and uninstalling a method pack (FR-012, FR-013a).
//
// A pack is an ordinary item with a `method/` facet (035: install copies
// nothing, it is one symlink). Installing it registers three things —
// descriptor, agent root, template mount — and uninstalling MUST remove all
// three. That symmetry is why unregisterMount had to exist (T002): without it
// an uninstalled pack's templates stay resolvable, which reads as "still
// installed".

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { unregisterMount } from "@/os/vfs";
import { logger } from "@/lib/logging/server-logger";
import { registerMethod, unregisterMethod, getMethod } from "./registry";
import { registerPackAgentRoot, unregisterPackAgentRoot, unregisterAllPackAgentRoots } from "@/lib/agent/subagents/roots";
import type { MethodDescriptor } from "./types";

const COMPONENT = "specs.method.install";

/** `method/method.json` — the descriptor, plus where the pack keeps its parts. */
export interface MethodManifest extends MethodDescriptor {
  /** Agents directory relative to the pack root; defaults to "method/agents". */
  agentsDir?: string;
  /** Whether the pack's agents appear in the picker. Defaults to "picker". */
  agentVisibility?: "picker" | "delegate-only";
}

/** Read a pack's descriptor from its installed item. */
export async function readMethodManifest(itemPath: string): Promise<MethodManifest> {
  const raw = await fs.readFile(path.join(itemPath, "method", "method.json"), "utf8");
  return JSON.parse(raw) as MethodManifest;
}

/** Whether a pack from `origin` may be installed without an explicit per-pack
 *  opt-in (FR-013a).
 *
 *  A method pack can carry a `plugin/` facet, which is arbitrary server-side
 *  code. From `user-apps` that is the user's OWN work and needs no ceremony.
 *  From any other marketplace it is third-party code, and the opt-in is
 *  recorded PER PACK — not a global "allow plugin packs" setting (which would
 *  silently cover every future pack) and not a dismissible warning (which is
 *  not a decision, just an obstacle). */
export function requiresOriginOptIn(facets: { plugin: boolean }, origin: "local" | "marketplace"): boolean {
  return facets.plugin && origin !== "local";
}

export class MethodOriginRefusedError extends Error {
  constructor(readonly packId: string) {
    super(
      `Method pack "${packId}" ships a plugin facet (server-side code) and came from a marketplace rather than your own user-apps. ` +
        `Installing it requires an explicit opt-in for this specific pack.`,
    );
  }
}

/** Per-pack opt-ins, persisted so a restart does not re-prompt. */
function optInFile(): string {
  return path.join(dataDir(), "system", ".method-pack-opt-ins.json");
}

async function readOptIns(): Promise<string[]> {
  try {
    return JSON.parse(await fs.readFile(optInFile(), "utf8")) as string[];
  } catch {
    return [];
  }
}

export async function hasOriginOptIn(packId: string): Promise<boolean> {
  return (await readOptIns()).includes(packId);
}

export async function recordOriginOptIn(packId: string): Promise<void> {
  const current = await readOptIns();
  if (current.includes(packId)) return;
  await fs.mkdir(path.dirname(optInFile()), { recursive: true });
  await fs.writeFile(optInFile(), JSON.stringify([...current, packId], null, 2));
}

export async function revokeOriginOptIn(packId: string): Promise<void> {
  const current = await readOptIns();
  await fs.writeFile(optInFile(), JSON.stringify(current.filter((id) => id !== packId), null, 2));
}

export interface InstallMethodInput {
  itemId: string;
  itemPath: string;
  facets: { plugin: boolean };
  origin: "local" | "marketplace";
}

/** Register a pack's descriptor, agent root and template mount.
 *
 *  Throws MethodOriginRefusedError when the origin gate applies and no opt-in
 *  is recorded — REFUSING rather than installing-and-warning, because a
 *  warning beside an already-completed install is not a gate. */
export async function installMethodPack(input: InstallMethodInput): Promise<MethodDescriptor> {
  const manifest = await readMethodManifest(input.itemPath);

  if (requiresOriginOptIn(input.facets, input.origin) && !(await hasOriginOptIn(manifest.id))) {
    throw new MethodOriginRefusedError(manifest.id);
  }

  // THE PACK ROOT is `<item>/method`, not the item root.
  //
  // `templates` and `agentsDir` are documented as PACK-relative, and the
  // built-in pack's root IS its directory (seed/method-packs/spec-kit). For an
  // installed item the pack lives one level down, inside the `method/` facet,
  // beside the item's app/services/plugin facets. Resolving pack-relative paths
  // against the ITEM root instead puts every one of them one directory too
  // high — and because the built-in pack is the only one exercised in-tree,
  // nothing noticed until a real item layout existed to install.
  const packRoot = path.join(input.itemPath, "method");

  // Registration validates schemaVersion and refuses an unsupported one,
  // naming both versions (SC-015). Do it FIRST: a pack that cannot register
  // must not leave an agent root or a mount behind. Recording the root here is
  // what lets remountMethodTemplates resolve `templates` correctly — without
  // it, spec-mount falls back to the item root and mounts a path that does not
  // exist.
  registerMethod(manifest, packRoot);

  // Agent roots. A MODULAR pack (048 FR-006) contributes one root per SELECTED
  // module, each with its own visibility — not one root per pack. A flat pack
  // keeps the single root it always had.
  const { activeModules, moduleAgentsDir } = await import("./modules");
  const modules = await activeModules(manifest);
  const modulesWithNoAgents: string[] = [];
  if (modules.length > 0) {
    for (const mod of modules) {
      const dir = path.join(packRoot, moduleAgentsDir(mod));
      // Skipped, but NOT silently — see the report below. A module whose agents
      // directory is absent contributes nothing, and `continue` alone made that
      // indistinguishable from a module that contributed successfully.
      if (!(await exists(dir))) {
        modulesWithNoAgents.push(`${mod.id} -> ${moduleAgentsDir(mod)}`);
        continue;
      }
      registerPackAgentRoot({
        // Namespaced per module so deselecting one removes exactly its agents
        // (SC-002), and so two modules of the same pack never collide on the
        // single per-pack key.
        packId: `${manifest.id}:${mod.id}`,
        path: dir,
        label: `${manifest.label} — ${mod.label ?? mod.id}`,
        // FR-007: per MODULE. BMM's cast is chain-dependent and belongs behind
        // agent_delegate; CIS and BMB are things a user talks to directly.
        visibility: mod.visibility ?? manifest.agentVisibility ?? "picker",
      });
    }
  } else {
    const agentsDir = path.join(packRoot, manifest.agentsDir ?? "agents");
    if (await exists(agentsDir)) {
      registerPackAgentRoot({
        packId: manifest.id,
        path: agentsDir,
        label: manifest.label,
        visibility: manifest.agentVisibility ?? "picker",
      });
    }
  }

  const { remountMethodTemplates } = await import("@/lib/specs/spec-mount");
  await remountMethodTemplates();

  // 048 T008 / FR-005 — the overlay's VFS mount. Created at install so BMB has
  // somewhere to write from its first run; the pack root itself stays
  // ReadonlyFS and must never be writable.
  //
  // ONE prefix per pack: /Methods/<id>/templates (045) and /Methods/<id>/overlay
  // (here). An earlier draft used /MethodPacks/<id>, giving one pack two
  // unrelated VFS prefixes.
  // Seed the pack's bundled skills NOW, not on the next boot.
  //
  // seedMethodPackSkills runs inside ensureSeed(), which is memoized per data
  // root and has already run by the time anyone installs anything. So without
  // this, a pack installed into a RUNNING BOS registers its descriptor, agents
  // and templates — and its skills simply are not there. A persona declaring
  // `skills: [bmad-bos-architecture]` then has that entry dropped by
  // filterAllowed SILENTLY: no error, no log, the agent just quietly loses the
  // skill that carries its method. Found by installing the real pack.
  const { seedPackBundledSkills } = await import("@/system/marketplace/install/bundledAssets");
  await seedPackBundledSkills(packRoot, manifest.id, manifest.version).catch((err) => {
    logger().warn(COMPONENT, "pack skill seeding failed", { packId: manifest.id, error: (err as Error).message });
  });

  const { ensureOverlay, overlayAgentsDir } = await import("./overlay");
  await ensureOverlay(manifest.id);
  const { registerMount } = await import("@/os/vfs");
  const { LocalFS } = await import("@/os/fs/local-fs");
  // LocalFS, NOT SpecFS: the overlay is deliberately not git-backed. US3 needs
  // customisations to survive a pack upgrade, which this satisfies; git-backing
  // would couple a user's agent edits to BOS's feature-branch machinery for no
  // stated requirement. Revisit if versioned customisation is ever wanted —
  // it is a swap of backend, not a change of shape.
  registerMount(`/Methods/${manifest.id}/overlay`, new LocalFS(path.dirname(overlayAgentsDir(manifest.id))));

  // A `roles` entry naming an agent nobody provides is silent rot: the binding
  // looks declared, `filterAllowed`-style lookups drop it with no error, and the
  // pack simply never delegates that role. Report it at install, where the
  // cause is visible, rather than at the moment a delegation quietly does
  // nothing. Reported, not refused — a role may legitimately bind to a BOS
  // capability agent this scan cannot see.
  const dangling = await danglingRoles(manifest);
  if (dangling.length) {
    logger().warn(COMPONENT, "method pack declares roles with no resolvable agent", {
      packId: manifest.id,
      roles: dangling.map((d) => `${d.role} -> ${d.agentId}`),
    });
  }

  // The same class of silent rot, one field over. A pack may declare a templates
  // directory it does not ship, and nothing noticed: the mount registers fine and
  // only fails when something first lists it. BMAD shipped in exactly that state
  // for as long as it has existed, while its own driver skill told five phases to
  // author against that mount.
  //
  // Git is why it stayed invisible — an empty directory cannot be committed, so
  // there was no missing file and no deletion to see. Only a check against the
  // INSTALLED tree can catch it, which is here.
  //
  // Reported, not refused, exactly like `roles`: a pack is perfectly usable
  // without templates, and refusing to install over it would be worse than
  // saying so.
  // Third instance of the same class, and the one that hid BMAD declaring `bmb`
  // and `cis` while shipping neither. A module with no agents directory is a
  // module the user can SELECT and that then contributes nothing at all — the
  // picker offers it, the install succeeds, and the absence surfaces only as
  // "why are there no CIS agents?" much later.
  if (modulesWithNoAgents.length) {
    logger().warn(COMPONENT, "method pack declares modules with no agents directory", {
      packId: manifest.id,
      modules: modulesWithNoAgents,
    });
  }

  const missingTemplates = await missingTemplatesDir(manifest, packRoot);
  if (missingTemplates) {
    logger().warn(COMPONENT, "method pack declares a templates directory it does not ship", {
      packId: manifest.id,
      declared: manifest.templates,
      resolved: missingTemplates,
    });
  }

  logger().info(COMPONENT, "method pack installed", { packId: manifest.id, itemId: input.itemId });
  return manifest;
}

/** The resolved path of a declared-but-absent templates directory, or undefined
 *  when the pack declares none or ships what it declared.
 *
 *  Absent and not-declared are DIFFERENT states and only the first is a mistake,
 *  which is why `templates` became optional rather than this check being lenient. */
export async function missingTemplatesDir(
  descriptor: MethodDescriptor,
  packRoot: string,
): Promise<string | undefined> {
  if (!descriptor.templates) return undefined;
  const abs = path.join(packRoot, descriptor.templates);
  try {
    return (await fs.stat(abs)).isDirectory() ? undefined : abs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return abs;
    // Unreadable is NOT absent. Reporting it as missing would send someone
    // looking for a directory that is right there behind a permissions problem.
    throw err;
  }
}

/** Remove every registration installMethodPack made.
 *
 *  Idempotent: each step reports whether it removed anything, and none throws
 *  on an absent registration, so a partially-installed pack can still be
 *  cleaned up. */
export class BuiltinMethodUninstallError extends Error {
  constructor(packId: string) {
    super(
      `"${packId}" is BrowserOS's built-in spec method and cannot be uninstalled: bos-system-specs is permanently bound to it. ` +
        `Upgrading it is fine; removing it would leave the system store with no method at all.`,
    );
  }
}

export async function uninstallMethodPack(packId: string): Promise<void> {
  // A modular pack registered one root PER MODULE, keyed `<packId>:<moduleId>`,
  // so removing the bare packId would leave every module's root behind.
  unregisterAllPackAgentRoots(packId);
  // The overlay's MOUNT goes; the overlay's CONTENT stays. A user's
  // customisations outliving an uninstall is deliberate — reinstalling the pack
  // restores them rather than silently discarding work (removeOverlay exists
  // for an explicit "discard my customisations" action).
  unregisterMount(`/Methods/${packId}/overlay`);
  // FR-009 scopes "no builtin special-casing" to REGISTRATION and RESOLUTION.
  // This refusal is itself a builtin special case, and is required: there is
  // no Marketplace row to click, but the registry API is reachable from any op
  // that enumerates packs.
  if (getMethod(packId)?.builtin) throw new BuiltinMethodUninstallError(packId);
  unregisterMethod(packId);
  unregisterPackAgentRoot(packId);
  unregisterMount(`/Methods/${packId}/templates`);
  logger().info(COMPONENT, "method pack uninstalled", { packId });
}

/** Store ids currently bound to a method — used to warn before uninstalling it
 *  (FR-016 / SC-011). A store left pointing at a removed pack must render
 *  "method not installed", never silently fall back to spec-kit and
 *  reinterpret its content. */
export async function storesBoundTo(packId: string): Promise<string[]> {
  const { listStores } = await import("@/lib/specs/stores");
  const { listProjects } = await import("@/lib/specs/projects");
  const bound: string[] = [];
  for (const store of await listStores()) {
    if (store.method === packId) {
      bound.push(store.id);
      continue;
    }
    if (store.owner === "item") continue;
    // A store that cannot be enumerated must not silently report "nothing is
    // bound here" — that is the answer that lets an uninstall proceed.
    for (const project of await listProjects(store.id)) {
      if (project.method === packId) bound.push(`${store.id}/${project.id}`);
    }
  }
  return bound;
}

/** `roles` entries whose agent no root provides.
 *
 *  Checked against DELEGATABLE agents, not picker-visible ones: a pack's cast
 *  is routinely `delegate-only`, which is exactly the case this must not
 *  report as missing. */
export async function danglingRoles(descriptor: MethodDescriptor): Promise<Array<{ role: string; agentId: string }>> {
  const entries = Object.entries(descriptor.roles ?? {});
  if (entries.length === 0) return [];
  const { listDelegatableAgents } = await import("@/lib/agent/subagents/store");
  // NOT `.catch(() => [])`. An empty set makes EVERY role look dangling, so a
  // failed agent scan would be reported as "this pack's entire cast is broken"
  // — a confident, wrong diagnosis pointing at the pack instead of the scan.
  const known = new Set((await listDelegatableAgents()).map((a) => a.id));
  return entries.filter(([, agentId]) => !known.has(agentId)).map(([role, agentId]) => ({ role, agentId }));
}

export function isMethodInstalled(id: string): boolean {
  return getMethod(id) !== undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The pack that WOULD provide `agentId`, if a store still references a method
 *  that is no longer installed (FR-016).
 *
 *  Best-effort and deliberately cheap: it consults the bindings, not the
 *  uninstalled pack's files (which are gone). Its only job is to turn "no
 *  matching agent" — which sends the reader hunting for a typo — into "that
 *  pack is not installed", which is the actual cause. */
export async function missingPackForAgent(agentId: string): Promise<string | undefined> {
  const { listStores } = await import("@/lib/specs/stores");
  const { listProjects } = await import("@/lib/specs/projects");
  const referenced = new Set<string>();
  for (const store of await listStores()) {
    if (store.method) referenced.add(store.method);
    if (store.owner === "item") continue;
    for (const p of await listProjects(store.id)) if (p.method) referenced.add(p.method);
  }
  for (const id of referenced) {
    if (!isMethodInstalled(id)) {
      // We cannot enumerate an uninstalled pack's agents, so any unresolved
      // agent id is attributed to the missing pack rather than guessed at.
      void agentId;
      return id;
    }
  }
  return undefined;
}

/** Memoized PER DATA ROOT, not per process. The boot pass and the lazy ensure
 *  share it, so whichever module instance runs first does the work and the other
 *  is a no-op — but `dataDir()` is env-driven and BOS moves it at runtime (a
 *  feature-branch data clone, a per-user container, a test's sandbox).
 *
 *  A single process-wide promise meant the FIRST root to be scanned was the only
 *  one ever registered: every later root got the first one's answer. That is the
 *  same defect `reconcileInstalledItemAssets` and the agent store's `seededRoots`
 *  were each fixed for, and it got worse when user workflows joined this pass —
 *  they live under `data/`, so the cached result then carried one root's forks
 *  into another's registry. */
const installedPacksReady = new Map<string, Promise<string[]>>();

/** Ensure installed packs are registered IN THIS MODULE INSTANCE.
 *
 *  The boot pass alone is not enough. Next.js gives the instrumentation hook and
 *  route handlers SEPARATE module instances, so a registry populated at boot is
 *  not the registry a route reads: the log said "installed method packs
 *  registered" while /api/methods returned only spec-kit.
 *
 *  ensureBuiltinMethod already self-heals for exactly this reason, which is why
 *  spec-kit appeared and an installed pack did not. This is the same contract
 *  for packs — idempotent, safe from anywhere, and the thing that makes "is the
 *  pack registered" independent of which entry point you came through. */
export async function ensureInstalledMethodPacks(): Promise<string[]> {
  const root = dataDir();
  let pass = installedPacksReady.get(root);
  if (!pass) {
    pass = registerInstalledMethodPacks()
      .then(async (packs) => {
        // 051 T009 — the user's own workflows, AFTER the packs. After, because a
        // fork must not shadow a pack's id, and because an override can only
        // resolve once its base is registered. A bad one is reported and skipped
        // rather than aborting the pass: it is user-editable data reaching a gate
        // built for pack data, and one malformed file must not take every store
        // bound to a workflow down with it.
        const { registerUserWorkflows } = await import("./user-workflows");
        const { registered } = await registerUserWorkflows();
        return [...packs, ...registered];
      })
      .catch((err) => {
        installedPacksReady.delete(root); // a failed pass must not poison every later call
        throw err;
      });
    installedPacksReady.set(root, pass);
  }
  return pass;
}

/** Re-register every INSTALLED method pack at boot (048 / 045 FR-012).
 *
 *  installMethodPack runs on the install ACTION. Nothing re-ran it on startup,
 *  so a pack's descriptor, agent roots, template mount and overlay all lived
 *  only in the memory of the process that installed it: the pack worked until
 *  the first restart and then silently vanished, while its item symlink, its
 *  overlay and its marketplace entry all still said it was installed.
 *
 *  Services (`serviceRegistry().initialize()`) and bos-plugins
 *  (`loadAllPlugins()`) each already had a boot pass. Method packs did not —
 *  this is that pass, and it is deliberately the SAME entry point the install
 *  action uses rather than a parallel one.
 *
 *  Failures are contained per pack and reported: one malformed descriptor must
 *  not stop the others registering, and must not take boot down.
 */
export async function registerInstalledMethodPacks(): Promise<string[]> {
  const { listInstalledItems } = await import("@/system/items/installed");
  const registered: string[] = [];
  // NOT `.catch(() => [])`. If this scan fails, ZERO packs register — and the
  // only symptom is every bound store reporting "method not installed", naming
  // a pack that is installed and never the reason. Per-pack containment is the
  // loop below; a failure to enumerate at all is not contained, it is total.
  const items = await listInstalledItems().catch((err) => {
    logger().error(COMPONENT, "could not scan installed items — NO method packs will register", undefined, {
      error: (err as Error).message,
    });
    throw err;
  });
  for (const item of items) {
    if (!item.facets.method || item.broken) continue;
    try {
      const descriptor = await installMethodPack({
        itemId: item.id,
        itemPath: item.itemPath,
        facets: { plugin: item.facets.plugin },
        origin: item.origin,
      });
      registered.push(descriptor.id);
    } catch (err) {
      // Includes MethodOriginRefusedError: a pack that needs an opt-in it no
      // longer has must NOT silently re-register at boot.
      logger().warn(COMPONENT, "installed method pack failed to register at boot", {
        itemId: item.id,
        error: (err as Error).message,
      });
    }
  }
  if (registered.length) logger().info(COMPONENT, "installed method packs registered", { packs: registered });
  return registered;
}
