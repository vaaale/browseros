// 045 T019 — what happens to the constitution when a store's method changes
// (FR-009a, SC-012).
//
// Every framework keeps its project principles somewhere, and nowhere is the
// same place: spec-kit uses `.specify/memory/constitution.md`, another may use
// `openspec/project.md`. Change the method and the old file is still on disk
// but nothing reads it — the store now has NO principles, silently, while a
// file that looks like principles sits right there.
//
// SINGLE OWNER. 046 and 047 deliberately do not specify this moment, so it is
// decided once, here, rather than three times with three behaviours.

import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import type { MethodDescriptor } from "./types";

export type ConstitutionOutcome =
  /** Moved from the old path to the new one. */
  | { kind: "relocated"; from: string; to: string }
  /** The old path holds content but the new method reads it from a DIFFERENT
   *  store (constitutionRoot), so moving it inside this store would not make
   *  it readable. Reported, not moved. */
  | { kind: "unreferenced"; path: string; reason: string }
  /** Neither path holds anything — the store has no principles under either
   *  method. Not an error, but it must be SAID: a store with no constitution
   *  reports `constitution: pending` forever and the user should know why. */
  | { kind: "absent"; expectedAt: string }
  /** Already where the new method expects it. */
  | { kind: "unchanged"; path: string };

/** Resolve a descriptor's constitution path within one store.
 *
 *  Returns null when the descriptor reads its constitution from ANOTHER store
 *  (constitutionRoot "system" while this is not the system store) — in that
 *  case this store does not own a constitution at all and relocating one into
 *  it would achieve nothing. */
function pathIn(storeId: string, descriptor: MethodDescriptor, isSystemStore: boolean): string | null {
  if (descriptor.constitutionRoot === "own") return `${storeId}/${descriptor.constitution}`;
  if (descriptor.constitutionRoot === "system") return isSystemStore ? `${storeId}/${descriptor.constitution}` : null;
  return `user-specs/${descriptor.constitution}`;
}

/** Relocate the constitution for an ACCEPTED method change, or report why not.
 *
 *  `apply: false` makes this a dry run, so the same logic drives the preview
 *  the user confirms and the action they confirmed — rather than a preview
 *  that describes one thing and a mutation that does another. */
export async function reconcileConstitution(
  storeId: string,
  from: MethodDescriptor,
  to: MethodDescriptor,
  opts: { isSystemStore: boolean; branch?: string; apply: boolean },
): Promise<ConstitutionOutcome> {
  const fromPath = pathIn(storeId, from, opts.isSystemStore);
  const toPath = pathIn(storeId, to, opts.isSystemStore);

  if (toPath === null) {
    // The new method reads principles from elsewhere. Whatever is at the old
    // path is now unreferenced; say so rather than moving it somewhere equally
    // unread.
    const stale = fromPath && (await specfs.readFile(fromPath).catch(() => "")) ? fromPath : null;
    return stale
      ? { kind: "unreferenced", path: stale, reason: `${to.label} reads its constitution from the ${to.constitutionRoot} store, not from ${storeId}.` }
      : { kind: "absent", expectedAt: `the ${to.constitutionRoot} store` };
  }

  if (fromPath === toPath) return { kind: "unchanged", path: toPath };

  const body = fromPath ? await specfs.readFile(fromPath).catch(() => "") : "";
  if (!body) {
    const existing = await specfs.readFile(toPath).catch(() => "");
    return existing ? { kind: "unchanged", path: toPath } : { kind: "absent", expectedAt: toPath };
  }

  if (!opts.apply) return { kind: "relocated", from: fromPath!, to: toPath };

  const ctx = opts.branch ? { branch: opts.branch } : undefined;
  await specfs.writeFile(toPath, body, ctx);
  // Remove the old copy only AFTER the new one is written. A failure between
  // the two leaves two copies, which is recoverable; the other order leaves
  // none, which is not.
  await specfs.remove(fromPath!, ctx).catch(() => {});
  return { kind: "relocated", from: fromPath!, to: toPath };
}

/** Does any phase in this descriptor actually READ the constitution?
 *
 *  Not every method gates on one. Asserting a consequence that cannot happen is
 *  worse than saying nothing: it sends a user to create a file no phase
 *  consults, and it teaches them to discount the next warning. */
export function constitutionIsRead(descriptor: MethodDescriptor): boolean {
  const path = descriptor.constitution;
  if (!path) return false;
  return descriptor.phases.some((phase) => JSON.stringify(phase.rules).includes(path));
}

export function describeConstitutionOutcome(o: ConstitutionOutcome, target?: MethodDescriptor): string {
  // `target` is optional so a caller without one still gets an accurate
  // description — it just omits the consequence clause rather than guessing.
  const read = target ? constitutionIsRead(target) : undefined;
  const phase = target?.phases.find((ph) => JSON.stringify(ph.rules).includes(target.constitution));

  switch (o.kind) {
    case "relocated":
      return `Constitution moved from ${o.from} to ${o.to}.`;
    case "unreferenced":
      return `${o.path} is no longer read by the active method. ${o.reason} Move or delete it deliberately — it is not principles any more, but it still looks like them.`;
    case "absent":
      if (read === false) {
        return `No constitution at ${o.expectedAt}, and ${target!.label} does not read one — no phase consults it, so nothing will report it missing.`;
      }
      if (read && phase) {
        return `No constitution at ${o.expectedAt}. The "${phase.label}" phase will report "${target!.stateLabels.pending}" until one exists.`;
      }
      return `No constitution at ${o.expectedAt}.`;
    case "unchanged":
      return `Constitution stays at ${o.path}.`;
  }
}
