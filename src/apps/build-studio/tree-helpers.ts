// Pure tree-walking helpers for the Build Studio spec tree (037-project-layer,
// Phase 4). Framework-free and independently unit-testable — no React, no
// fetch. Replaces the old featureIdOf/findBranchInTree, both of which assumed
// a fixed depth (store -> feature -> file); the tree is now recursive
// (store -> project -> arbitrary plain folders -> feature -> file), except
// for an item-owned group, which keeps its old flat, depth-agnostic shape
// (item-stores.ts has no Projects at all).
import type { SpecTreeNode } from "@/lib/specs/types";

export interface TreeMatch {
  node: SpecTreeNode;
  /** From the top-level group down to (not including) `node` itself. */
  ancestors: SpecTreeNode[];
}

function walk(nodes: SpecTreeNode[], path: string, ancestors: SpecTreeNode[]): TreeMatch | null {
  for (const node of nodes) {
    if (node.path === path) return { node, ancestors };
    if (node.children) {
      const found = walk(node.children, path, [...ancestors, node]);
      if (found) return found;
    }
  }
  return null;
}

/** Find a node anywhere in the tree by its exact path, with its ancestor chain. */
export function findInTree(tree: SpecTreeNode[], path: string): TreeMatch | null {
  for (const group of tree) {
    if (group.path === path) return { node: group, ancestors: [] };
    if (group.children) {
      const found = walk(group.children, path, [group]);
      if (found) return found;
    }
  }
  return null;
}

/** The store id a store-prefixed path belongs to (its first segment). */
export function storeIdOf(path: string): string {
  return path.split("/")[0] ?? "";
}

/** The feature (a directory directly containing spec.md) that owns a given
 *  artifact path. An item-owned group has no Project layer at all — the
 *  store id itself IS the feature (item-stores.ts) — everything else walks
 *  the tree to find the nearest ancestor "feature" node, at any depth. */
export function featureIdOf(path: string, tree: SpecTreeNode[]): string {
  const storeId = storeIdOf(path);
  const group = tree.find((g) => g.path === storeId);
  if (group?.owner === "item") return storeId;
  const match = findInTree(tree, path);
  if (!match) return path.split("/").slice(0, 2).join("/"); // best-effort fallback for a not-yet-refreshed tree
  if (match.node.type === "feature") return match.node.path;
  const featureAncestor = [...match.ancestors].reverse().find((a) => a.type === "feature");
  return featureAncestor?.path ?? match.node.path;
}

/** The `bos/*` draft branch a node at `path` lives on, if any (020) — a
 *  generic search at any depth, not a fixed number of levels. */
export function findBranchInTree(tree: SpecTreeNode[], path: string): string {
  return findInTree(tree, path)?.node.branch ?? "";
}

