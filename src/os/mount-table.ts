// Pure mount-resolution logic for the VFS mount table (027-vfs-specfs).
// No `server-only`, no fs — kept dependency-light so it is unit-testable and
// safe to import anywhere. The actual filesystem work lives in the backends
// (LocalFS, SpecFS); this module only decides WHICH backend a path belongs to
// and computes the backend-relative sub-path.
//
// Security note: matching operates on an ALREADY-NORMALIZED POSIX path (leading
// "/", no "." or ".." segments — see normalizeVfsPath). Because normalization
// collapses traversal before matching, a "…/../.." attempt can never land inside
// a mount it didn't textually belong to, and the returned `rel` never contains
// "..". The per-backend root jail is the second line of defence.

import path from "path";

export interface MountResolution {
  /** The matched mount prefix, normalized (leading "/", no trailing "/"). */
  prefix: string;
  /** Path relative to the mount root, POSIX, no leading slash, never contains "..". */
  rel: string;
}

/** Normalize a mount prefix to a canonical form: leading "/", no trailing "/". */
export function normalizeMountPrefix(prefix: string): string {
  const norm = path.posix.normalize("/" + (prefix || "/"));
  return norm === "/" ? "/" : norm.replace(/\/+$/, "");
}

/**
 * Given a normalized VFS path and a set of registered mount prefixes, return the
 * longest-matching mount and the backend-relative sub-path, or null if no mount
 * matches (caller falls through to the default local filesystem).
 *
 * `normalizedPath` MUST already be normalized (path.posix.normalize("/" + p)).
 */
export function resolveMountPath(normalizedPath: string, prefixes: string[]): MountResolution | null {
  let best: MountResolution | null = null;
  for (const raw of prefixes) {
    const prefix = normalizeMountPrefix(raw);
    const isMatch = normalizedPath === prefix || normalizedPath.startsWith(prefix + "/");
    if (!isMatch) continue;
    if (best && best.prefix.length >= prefix.length) continue;
    const rel = normalizedPath.slice(prefix.length).replace(/^\/+/, "");
    best = { prefix, rel };
  }
  return best;
}
