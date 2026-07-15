// Pure helpers for Feature Context ids and branch names (027-vfs-specfs).
// No `server-only` — unit-testable. Reference: DRAFT_BRANCH in store-git.ts.

export const FEATURE_ID_RE = /^[a-z0-9-]+$/;

/** Validate a feature id, or throw. Guards branch-ref injection and worktree
 *  path traversal (id becomes part of both a git ref and a directory name). */
export function sanitizeFeatureId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!FEATURE_ID_RE.test(trimmed)) {
    throw new Error(
      `Invalid feature id "${id}". Use lowercase letters, digits, and hyphens only (^[a-z0-9-]+$).`,
    );
  }
  return trimmed;
}

/** The git branch for a feature: `bos/feat/<id>`. */
export function branchForFeature(id: string): string {
  return `bos/feat/${sanitizeFeatureId(id)}`;
}

/** Flat-encode a (possibly slashed) branch name into a single safe directory
 *  segment for a self-provisioned worktree (N6): `bos/feat/x` → `bos__feat__x`.
 *  Reversible because the branch alphabet excludes "_". */
export function encodeBranchDir(branch: string): string {
  return branch.replace(/\//g, "__");
}
