// 049 FR-011 — binding scope is a property of the repository KIND.
//
// One rule cannot be right for every store. A marketplace repo holds many
// independent products; `user-specs` holds refinements to ONE product (BOS) and
// therefore has one pipeline for all of it; `bos-system-specs` is BOS's own and
// read-only. Getting this wrong is not cosmetic — it decides whether a user is
// offered a control that cannot mean anything where they clicked it.
//
// KIND and OWNERSHIP are different axes. Kind decides binding scope and what a
// Project is. Ownership decides writability. Only the system store is BOS-owned
// and read-only; everything else is the user's and writable on a branch.
//
// Framework-free: pure functions over a SpecStore. No I/O.

import type { SpecStore } from "./stores";

export type StoreKind =
  /** BOS's own specs. Read-only, binds nowhere. Exactly one. */
  | "system"
  /** The user's refinements to BOS. The STORE is one project. Exactly one. */
  | "user-specs"
  /** A marketplace repo. Its PROJECTS are its items — one repo, many projects. */
  | "marketplace"
  /** One item within a marketplace repo. It IS a project (049's decision: keep
   *  `item-<id>` addressing, change policy and presentation only). */
  | "item"
  /** Any non-BOS repository. The repo is one project. Many allowed. `050`. */
  | "arbitrary";

/** Where a method/workflow may be bound within this store.
 *
 *  `none`    — nothing may be bound (read-only).
 *  `store`   — one binding governs everything in it.
 *  `project` — each Project inside it binds independently.
 */
export type BindingScope = "none" | "store" | "project";

export function kindOf(store: SpecStore): StoreKind {
  // DECLARED wins (050 FR-002). Recorded in the manifest so it survives a
  // restart and travels with the repository, rather than being guessed from
  // where a directory happens to sit.
  if (store.kind) return store.kind === "user-specs" ? "user-specs" : store.kind;
  // Undeclared falls back to what the store already was, so no existing store
  // changes meaning and there is no migration step.
  if (store.owner === "system") return "system";
  if (store.owner === "item") return "item";
  if (store.owner === "marketplace") return "marketplace";
  return "user-specs";
}

export function bindingScopeOf(store: SpecStore): BindingScope {
  switch (kindOf(store)) {
    case "system":
      return "none";
    // An item IS a project; its store-level binding is that project's binding.
    case "item":
      return "store";
    // BOS is one product, so its user specs have one pipeline. The 36 Project
    // folders keep their `037` role — organizational grouping and feature
    // numbering — they simply are not binding points.
    case "user-specs":
      return "store";
    case "arbitrary":
      return "store";
    case "marketplace":
      return "project";
  }
}

/** What a "Project" means inside this store, for the lifecycle tools. */
export function projectsAre(store: SpecStore): "none" | "folders" | "items" {
  switch (kindOf(store)) {
    case "system":
      return "none";
    case "marketplace":
      return "items";
    case "item":
      return "none"; // an item is itself a project; it contains none
    default:
      return "folders";
  }
}

/** May a per-PROJECT binding be honoured here?
 *
 *  False for every store-scoped kind. A binding that is present but not
 *  honoured must be REPORTED rather than silently ignored (FR-011b) — both
 *  silent options leave the user with a binding they can neither see nor act
 *  on, which is how the per-Project picker came to be offered where it could
 *  never take effect. */
export function honoursProjectBinding(store: SpecStore): boolean {
  return bindingScopeOf(store) === "project";
}
