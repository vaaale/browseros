// 045 T008/T009 — THE leaf rule (FR-006, SC-004).
//
// "Is this directory a unit?" had FOUR implementations before 045:
//   pipeline.ts:202  entries.some(e => e.name === "spec.md")      (walk)
//   pipeline.ts:215  entries.some(e => e.name === "spec.md")      (tree)
//   pipeline.ts:291  f.endsWith("/spec.md")                       (branch overlay)
//   projects.ts:85   specfs.exists(`.../spec.md`)                 (public helper)
//
// Three shapes of the same question over three different inputs — a listing, a
// path list, and a stat — which is why the literal was easy to miss in the
// third. SC-004 requires exactly one location to decide it.
//
// Lives in its own module rather than in pipeline.ts because projects.ts needs
// it too, and projects.ts is imported BY pipeline.ts — putting it there would
// be an import cycle.

import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import type { MethodDescriptor, SectionSpec } from "./method/types";

/** Every file name that marks a leaf under this descriptor. Usually one, but a
 *  descriptor may declare several sections with different markers (OpenSpec's
 *  changes/ and specs/ do not use the same one). */
export function leafMarkers(descriptor: MethodDescriptor): string[] {
  return [...new Set(descriptor.sections.map((s) => s.leafMarker))];
}

/** THE section rule: which section owns a store-relative path.
 *
 *  LONGEST PREFIX WINS, and that is the whole point. OpenSpec declares both
 *  `changes` and `changes/archive`; every archived change is also under
 *  `changes`, so a first-match rule would file history as active work — and an
 *  archived change evaluated as active advertises "tasks: available" for work
 *  finished months ago.
 *
 *  A `rel: ""` section matches everything at length 0, so it loses to any
 *  explicit section and wins when nothing else matches. For spec-kit and BMAD —
 *  one section, `rel: ""` — this returns that section for every path, which is
 *  what keeps their behaviour byte-identical. */
export function sectionFor(descriptor: MethodDescriptor, relPath = ""): SectionSpec {
  let best: SectionSpec | undefined;
  let bestLen = -1;
  for (const s of descriptor.sections) {
    const matches = s.rel === "" || relPath === s.rel || relPath.startsWith(`${s.rel}/`);
    if (matches && s.rel.length > bestLen) {
      best = s;
      bestLen = s.rel.length;
    }
  }
  return best ?? descriptor.sections[0];
}

/** The marker for the section owning `relPath`.
 *
 *  Takes a PATH, not a section rel: callers know where a unit lives, not which
 *  section that implies, and making them work it out is how the two drift. */
export function leafMarkerFor(descriptor: MethodDescriptor, relPath = ""): string {
  return sectionFor(descriptor, relPath).leafMarker;
}

/** Leaf test over a directory LISTING.
 *
 *  `relPath` narrows the test to the marker of the section that owns it. Without
 *  it every section's marker applies everywhere, so an OpenSpec `specs/` folder
 *  containing a stray proposal.md would be read as a change. Omitted (or under a
 *  single-section descriptor) the behaviour is the previous any-marker test. */
export function isLeafListing(
  entries: { type: string; name: string }[],
  descriptor: MethodDescriptor,
  relPath?: string,
): boolean {
  const markers = relPath === undefined ? leafMarkers(descriptor) : [sectionFor(descriptor, relPath).leafMarker];
  return entries.some((e) => e.type === "file" && markers.includes(e.name));
}

/** Leaf test by STAT — for a path we have not listed. */
export async function isLeafDir(storeId: string, relPath: string, descriptor: MethodDescriptor): Promise<boolean> {
  for (const marker of leafMarkers(descriptor)) {
    if (await specfs.exists(`${storeId}/${relPath}/${marker}`)) return true;
  }
  return false;
}

/** Leaf directories implied by a flat list of file PATHS — the draft-branch
 *  overlay's input, where there is no directory listing to consult because the
 *  content exists only in git.
 *
 *  This was the non-obvious copy: `endsWith("/spec.md")` reads as a path
 *  suffix test rather than as the leaf rule, so a marker change would have
 *  silently skipped it and drafts would have stopped appearing — for exactly
 *  the features a user is most likely to be working on. */
export function leafDirsFromPaths(paths: string[], descriptor: MethodDescriptor): Set<string> {
  const out = new Set<string>();
  for (const marker of leafMarkers(descriptor)) {
    const suffix = `/${marker}`;
    for (const p of paths) {
      if (p.endsWith(suffix)) out.add(p.slice(0, -suffix.length));
      else if (p === marker) out.add(""); // marker at the store root (an item store)
    }
  }
  return out;
}
