// 045 T018 — preflight for a method change (FR-010, FR-010a, FR-010c).
//
// Changing a store's method changes what counts as a unit. spec-kit finds a
// feature wherever a directory contains spec.md; a framework whose leafMarker
// is `proposal.md` finds NONE of them. The content is not deleted — it simply
// stops being discovered, which to a user is indistinguishable from deletion
// and is worse, because nothing reports it.
//
// So: run discovery TWICE — under the effective descriptor and under the
// candidate — and report the set difference BY PATH. A count is not enough
// ("3 features would be hidden" does not tell you which, or whether they
// matter).
//
// ONE IMPLEMENTATION, TWO TRIGGERS (FR-010c). The same check runs on a
// user-initiated assignment AND on a pack UPGRADE that changes the effective
// descriptor. An upgrade is the more dangerous of the two precisely because
// nobody chose it: a pack bumping its leafMarker in v2 would otherwise empty
// every store bound to it, silently, on restart.

import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import { listStores } from "@/lib/specs/stores";
import { listProjects } from "@/lib/specs/projects";
import { listDraftBranches, listAllBranchFiles } from "@/lib/specs/store-git";
import { isLeafListing, leafDirsFromPaths } from "../leaf";
import type { MethodDescriptor } from "./types";

export interface PreflightReport {
  storeId: string;
  fromMethod: string;
  toMethod: string;
  /** Unit paths discovered now but NOT under the candidate — the ones that
   *  would stop being visible. */
  orphaned: string[];
  /** Unit paths the candidate would newly discover. */
  gained: string[];
  /** Paths that exist only on a draft `bos/*` branch. Called out separately
   *  because they are what a user is most likely to be working on right now,
   *  and least likely to notice disappearing from the sidebar. */
  orphanedOnBranch: string[];
  /** True when applying the change would hide existing content. Callers must
   *  treat this as a STOP, not a warning to render beside a Confirm button
   *  that is already enabled. */
  wouldOrphan: boolean;
}

/** Every unit path a descriptor discovers in a store, including draft-branch
 *  content. Store-relative (e.g. "bos/003-foo"). */
async function discover(
  storeId: string,
  storeRoot: string,
  descriptor: MethodDescriptor,
  projectId?: string,
): Promise<{ base: Set<string>; onBranch: Set<string> }> {
  const base = new Set<string>();
  if (projectId) {
    // A per-Project binding governs that Project's subtree and nothing else, so
    // the preflight must not count units elsewhere in the store as orphaned —
    // they keep their own binding and are entirely unaffected. Sections with a
    // `rel` are store-level folders OUTSIDE any Project, which is why they are
    // skipped here rather than re-rooted under it.
    await walk(storeId, projectId, descriptor, base);
  } else {
    for (const section of descriptor.sections) {
      const roots = section.rel ? [section.rel] : (await listProjects(storeId)).map((p) => p.id);
      for (const root of roots) await walk(storeId, root, descriptor, base);
    }
  }

  // Draft branches: the content has no base copy at all, so a listing-based
  // walk cannot see it. leafDirsFromPaths is the same leaf rule over git's
  // flat path list (leaf.ts) — NOT a second implementation.
  const onBranch = new Set<string>();
  for (const branch of await listDraftBranches(storeRoot).catch(() => [] as string[])) {
    const files = await listAllBranchFiles(storeRoot, branch).catch(() => [] as string[]);
    for (const dir of leafDirsFromPaths(files, descriptor)) {
      if (!dir || base.has(dir)) continue;
      if (projectId && dir !== projectId && !dir.startsWith(`${projectId}/`)) continue;
      onBranch.add(dir);
    }
  }
  return { base, onBranch };
}

/** Every unit leaf under `rel`, by the descriptor's own leaf rule. Exported so
 *  `gate-impact.ts` walks with the same rule rather than a second copy of it —
 *  `pipeline.ts` had four copies of this once (045 SC-004). */
export async function walkUnits(storeId: string, rel: string, descriptor: MethodDescriptor, out: Set<string>): Promise<void> {
  return walk(storeId, rel, descriptor, out);
}

async function walk(storeId: string, rel: string, descriptor: MethodDescriptor, out: Set<string>): Promise<void> {
  const entries = await specfs.listDir(`${storeId}/${rel}`).catch(() => []);
  if (isLeafListing(entries, descriptor)) {
    out.add(rel);
    return;
  }
  for (const e of entries) if (e.type === "dir") await walk(storeId, `${rel}/${e.name}`, descriptor, out);
}

/** Compare what `from` discovers against what `to` would. */
export async function preflightMethodChange(
  storeId: string,
  from: MethodDescriptor,
  to: MethodDescriptor,
  /** Scope the check to ONE Project (FR-008). Without it the report would list
   *  every unit in the store, most of which a per-Project change cannot touch —
   *  turning a safe binding into an alarming wall of false orphans. */
  projectId?: string,
): Promise<PreflightReport> {
  const store = (await listStores()).find((s) => s.id === storeId);
  if (!store) throw new Error(`Unknown spec store "${storeId}".`);

  const [before, after] = await Promise.all([
    discover(storeId, store.root, from, projectId),
    discover(storeId, store.root, to, projectId),
  ]);

  const orphaned = [...before.base].filter((p) => !after.base.has(p)).sort();
  const orphanedOnBranch = [...before.onBranch].filter((p) => !after.onBranch.has(p)).sort();
  const gained = [...after.base].filter((p) => !before.base.has(p)).sort();

  return {
    storeId: projectId ? `${storeId}/${projectId}` : storeId,
    fromMethod: from.id,
    toMethod: to.id,
    orphaned,
    orphanedOnBranch,
    gained,
    wouldOrphan: orphaned.length > 0 || orphanedOnBranch.length > 0,
  };
}

/** Human-readable summary. Lists paths, never just a count — "3 features would
 *  be hidden" tells a user nothing about whether they can accept that. */
export function describePreflight(r: PreflightReport): string {
  if (!r.wouldOrphan) {
    const gained = r.gained.length ? ` ${r.gained.length} unit(s) would become visible.` : "";
    return `Switching ${r.storeId} from ${r.fromMethod} to ${r.toMethod} hides nothing.${gained}`;
  }
  const lines = [
    `Switching ${r.storeId} from ${r.fromMethod} to ${r.toMethod} would HIDE ${r.orphaned.length + r.orphanedOnBranch.length} unit(s).`,
    "They are not deleted — they stop being discovered, because the new method looks for a different marker file.",
  ];
  if (r.orphaned.length) lines.push("", "On the base branch:", ...r.orphaned.map((p) => `  ${p}`));
  if (r.orphanedOnBranch.length) {
    lines.push("", "On a draft feature branch (work in progress):", ...r.orphanedOnBranch.map((p) => `  ${p}`));
  }
  lines.push("", "Recommended: adopt a new method on a NEW store or Project rather than converting this one.");
  return lines.join("\n");
}

/** FR-010c — the upgrade trigger. Called when a pack re-registers with a
 *  descriptor that differs from the one its stores were bound to.
 *
 *  Returns the stores that would lose content. Nobody CHOSE an upgrade, so
 *  this holds and reports rather than applying: the caller must not proceed
 *  for any store in the returned list. */
export async function preflightMethodUpgrade(
  from: MethodDescriptor,
  to: MethodDescriptor,
  boundStoreIds: string[],
): Promise<PreflightReport[]> {
  const reports = await Promise.all(boundStoreIds.map((id) => preflightMethodChange(id, from, to).catch(() => null)));
  return reports.filter((r): r is PreflightReport => r !== null && r.wouldOrphan);
}
