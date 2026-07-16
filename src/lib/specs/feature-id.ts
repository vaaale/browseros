// Pure helpers for feature branch slugs / worktree dir names (027-vfs-specfs).
// No `server-only` — unit-testable. Branch NAMING (bos/<kebab>) + validation is
// owned by src/lib/agent/feature-branch.ts; this module only provides a slug
// sanitizer (for a create-branch UI) and the worktree-dir encoding.

export const FEATURE_ID_RE = /^[a-z0-9-]+$/;

/** Normalize a user-entered feature name into a safe kebab slug, or throw when
 *  it cannot be represented. Used by the option-(b) create-branch UI. */
export function sanitizeFeatureId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!FEATURE_ID_RE.test(trimmed)) {
    throw new Error(
      `Invalid feature id "${id}". Use lowercase letters, digits, and hyphens only (^[a-z0-9-]+$).`,
    );
  }
  return trimmed;
}

/** Flat-encode a (possibly slashed) branch name into a single safe directory
 *  segment for a self-provisioned worktree (N6): `bos/my-change` → `bos__my-change`.
 *  Reversible because the branch alphabet excludes "_". */
export function encodeBranchDir(branch: string): string {
  return branch.replace(/\//g, "__");
}
