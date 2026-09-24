// 045 T012 — where agents come from (FR-001, FR-001a).
//
// Before 045 there was exactly one source, `data/agents/`, so a method pack had
// no way to contribute the cast its process assumes: BMAD's "Sally" or
// OpenSpec's reviewer had to be hand-copied by the user, and would then be
// indistinguishable from one they wrote themselves.
//
// ONE precedence rule lives here. `048` FR-002a extends this list (a provider
// root that generates agents rather than reading files); it must extend it
// rather than introduce a second ordering somewhere else.

import path from "path";
import { dataDir } from "@/os/data-dir";
import type { Agent } from "./types";

/** What a provider returns (048 FR-001, FR-003).
 *
 *  A STRUCT rather than a bare `Agent[]` so the phase graph can arrive later
 *  without a second provider shape — BMAD's `config.yaml` +
 *  `input_file_patterns` will need the same treatment, and retrofitting a
 *  second shape is how two mechanisms happen. `phases` is declared here and
 *  read NOWHERE in 048 (ADR-6). */
export interface ProviderOutput {
  agents: Agent[];
  /** Reserved for the pack's phase graph. Unread in 048. */
  phases?: unknown[];
}

interface AgentRootBase {
  /** Where this root's agents may appear.
   *
   *  `picker`        — listed in the agent picker, like any other agent.
   *  `delegate-only` — reachable by `agent_delegate` but NOT offered as a chat
   *                    agent. A pack's internal cast (a reviewer a driver
   *                    delegates to) would otherwise bury the handful of
   *                    agents a user actually starts conversations with.
   *
   *  Visibility scopes DISCOVERY only. Registration and delegability are
   *  unconditional — a hidden agent that cannot be delegated to is not hidden,
   *  it is broken (FR-001b). */
  visibility: "picker" | "delegate-only";
  /** Which pack contributed it; absent for BOS's own roots. Shown in the
   *  picker so two packs' similarly-named agents stay distinguishable. */
  packId?: string;
  /** Display name for grouping. */
  label: string;
}

/** Agents as `<id>/AGENT.md` files under a directory. BOS's own roots, and a
 *  pack whose agents are already in BOS format. */
export interface DirAgentRoot extends AgentRootBase {
  kind: "dir";
  /** Absolute path holding `<id>/AGENT.md` subdirectories. */
  path: string;
}

/** Agents produced by a pure function instead of read from disk (048 M1).
 *
 *  Exists because a framework may define its cast in its OWN format — BMAD's
 *  is YAML in a different shape — and rewriting it into `AGENT.md` files at
 *  install would break 035's "install copies nothing", create a derived cache
 *  with no natural invalidation point, and put BOS-authored files inside a
 *  user-owned tree where neither the `.seed-rev` nor the provenance contract
 *  applies. */
export interface ProviderAgentRoot extends AgentRootBase {
  kind: "provider";
  /** Required here: a provider always belongs to a pack. */
  packId: string;
  /** Pure — pack files in, in-memory results out. MUST emit no files. */
  resolve(): Promise<ProviderOutput>;
  /** Paths whose max mtime keys the cache. Empty ⇒ never cached. */
  watch: string[];
}

export type AgentRoot = DirAgentRoot | ProviderAgentRoot;

/** A pack root, as registered at install time (T024). */
export interface PackAgentRoot {
  packId: string;
  path: string;
  label: string;
  visibility?: "picker" | "delegate-only";
}

const packRoots = new Map<string, PackAgentRoot>();
/** Providers, keyed by pack id — the same namespace as `packRoots`, so a pack
 *  contributes EITHER a directory or a provider, never both under one id. */
const providers = new Map<string, ProviderAgentRoot>();

export function registerPackAgentRoot(root: PackAgentRoot): void {
  packRoots.set(root.packId, root);
}
export function unregisterPackAgentRoot(packId: string): boolean {
  return packRoots.delete(packId);
}

/** Register a provider (048 T005). Called from a pack's `plugin/` facet
 *  through the existing `loadAllPlugins()` — no new loader (ADR-5). */
export function registerAgentProvider(root: ProviderAgentRoot): void {
  providers.set(root.packId, root);
}

/** Remove every root a pack registered, including per-module ones keyed
 *  `<packId>:<moduleId>` (048 T011). Uninstall must not leave a module's root
 *  behind — its agents would keep resolving from a pack that is gone. */
export function unregisterAllPackAgentRoots(packId: string): number {
  let removed = 0;
  for (const key of [...packRoots.keys(), ...providers.keys()]) {
    if (key === packId || key.startsWith(`${packId}:`)) {
      if (packRoots.delete(key)) removed++;
      if (providers.delete(key)) removed++;
    }
  }
  return removed;
}

export function unregisterAgentProvider(packId: string): boolean {
  return providers.delete(packId);
}

export function __resetPackAgentRootsForTest(): void {
  packRoots.clear();
  providers.clear();
}

/** Roots in PRECEDENCE ORDER, highest first. ONE total order across all four
 *  levels — 048 FR-002a requires there be no second precedence rule anywhere.
 *
 *  1. `data/agents/`               — the deployment's own copies. A hand-written
 *     BOS-format agent is a deliberate override and stays the final word; same
 *     "local edits are never clobbered" contract `.seed-rev` enforces.
 *  2. `data/method-packs/<id>/agents/` — the user's OVERLAY (048). Outranks the
 *     pack root because it exists precisely to shadow it: BMB writes here, and
 *     a customisation that lost to the pack it customises would be pointless
 *     (US3).
 *  3. pack roots, sorted by PACK ID — deterministic, deliberately NOT install
 *     order. Install order varies per machine, so resolving collisions by it
 *     would make "which agent did I get" depend on history nobody can inspect.
 *     Directory- and provider-backed packs share this one level.
 *  4. `seed/agents/`               — what BOS ships.
 */
export function agentRoots(): AgentRoot[] {
  const roots: AgentRoot[] = [
    { kind: "dir", path: path.join(dataDir(), "agents"), visibility: "picker", label: "This deployment" },
  ];

  // Level 2. Built by iterating INSTALLED PACKS and asking each whether it has
  // an overlay — never by listing the overlay directory, which would let an
  // overlay for an uninstalled pack contribute agents and thereby become a
  // second install path (FR-004a).
  // ONE overlay per PACK, not per module. A modular pack registers roots keyed
  // `<packId>:<moduleId>` (048 T011), so iterating those keys directly would
  // create `data/method-packs/bmad:bmm/agents` — an overlay per module, which
  // is neither where BMB writes nor what the user thinks they are customising.
  const overlayed = new Map<string, { label: string; visibility?: "picker" | "delegate-only" }>();
  for (const [key, meta] of [...packRoots.entries(), ...providers.entries()]) {
    const packId = key.split(":")[0];
    if (!overlayed.has(packId)) {
      overlayed.set(packId, { label: meta.label.split(" — ")[0], visibility: meta.visibility });
    }
  }
  for (const packId of [...overlayed.keys()].sort()) {
    const meta = overlayed.get(packId)!;
    roots.push({
      kind: "dir",
      path: path.join(dataDir(), "method-packs", packId, "agents"),
      visibility: meta.visibility ?? "picker",
      packId,
      label: `${meta.label} (customised)`,
    });
  }
  // Directory roots and providers share ONE ordering — sorted together by pack
  // id, so a provider-backed pack and a file-backed one interleave
  // deterministically rather than forming two tiers.
  const packLevel: AgentRoot[] = [
    ...[...packRoots.values()].map<AgentRoot>((p) => ({
      kind: "dir", path: p.path, visibility: p.visibility ?? "picker", packId: p.packId, label: p.label,
    })),
    ...providers.values(),
  ].sort((a, b) => (a.packId ?? "").localeCompare(b.packId ?? ""));
  roots.push(...packLevel);
  roots.push({ kind: "dir", path: path.join(process.cwd(), "seed", "agents"), visibility: "picker", label: "BrowserOS" });
  return roots;
}

/** The ONLY root seed reconciliation may write to.
 *
 *  applySeedAgent and archiveDroppedSeedAgents must never write into a pack
 *  root: those files belong to an installed item, and BOS rewriting them would
 *  be modified on next upgrade of that item — silently reverting a user's
 *  edits and, worse, making the pack's own content diverge from the item it
 *  came from (SC-008). */
export function seedWriteRoot(): string {
  return path.join(dataDir(), "agents");
}

export interface AgentCollision {
  id: string;
  /** Roots offering the same id, in precedence order; the first one wins. */
  roots: string[];
}

/** Ids offered by more than one PACK.
 *
 *  Reported, never silently resolved by order. Two packs both shipping an
 *  "architect" is a real conflict a user has to know about — quietly taking
 *  the alphabetically-first one means their OpenSpec reviews are being run by
 *  BMAD's architect with no indication anywhere. */
export function collisionsAmong(idsByRoot: Array<{ root: AgentRoot; ids: string[] }>): AgentCollision[] {
  // Keyed by DISTINCT pack id, not by root. 048 gives every pack a second root
  // (its overlay), so grouping by root would report every customised agent as
  // colliding with the pack it customises — which is the designed behaviour,
  // not a conflict. A collision is two DIFFERENT packs offering one id.
  const seen = new Map<string, Map<string, string>>();
  for (const { root, ids } of idsByRoot) {
    if (!root.packId) continue; // only packs collide; data/ and seed/ are BOS's own layering
    for (const id of ids) {
      const byPack = seen.get(id) ?? new Map<string, string>();
      // Keep the FIRST (highest-precedence) label seen for a pack, so the
      // report names the root that actually wins.
      if (!byPack.has(root.packId)) byPack.set(root.packId, root.label);
      seen.set(id, byPack);
    }
  }
  return [...seen.entries()]
    .filter(([, byPack]) => byPack.size > 1)
    .map(([id, byPack]) => ({ id, roots: [...byPack.values()] }));
}

export interface ShadowedPackAgent {
  id: string;
  /** The pack whose copy is being shadowed. */
  packLabel: string;
  /** The root that wins. */
  shadowedBy: string;
}

/** Pack agents hidden by a higher-precedence copy (046 T010 / FR-010).
 *
 *  DISTINCT from `collisionsAmong`, though they share a home: a collision is two
 *  PACKS offering the same id, and its trigger is ambiguity. This one's trigger
 *  is PRECEDENCE — a `data/agents/<id>` copy legitimately winning over a pack's.
 *  That is the documented behaviour and usually what the user wants, but it is
 *  also how a pack upgrade silently fails to take effect: the pack ships a fixed
 *  architect, and the deployment keeps running its own edited copy forever with
 *  nothing indicating why. Reported, not resolved. */
export function shadowedPackAgents(idsByRoot: Array<{ root: AgentRoot; ids: string[] }>): ShadowedPackAgent[] {
  const out: ShadowedPackAgent[] = [];
  const seen = new Map<string, AgentRoot>();
  for (const { root, ids } of idsByRoot) {
    for (const id of ids) {
      const winner = seen.get(id);
      if (winner === undefined) {
        seen.set(id, root);
        continue;
      }
      // Only a PACK's copy being shadowed is worth reporting. seed/ losing to
      // data/ is the ordinary .seed-rev contract and would drown the signal.
      if (root.packId && !winner.packId) out.push({ id, packLabel: root.label, shadowedBy: winner.label });
    }
  }
  return out;
}
