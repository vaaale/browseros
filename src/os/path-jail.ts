// Pure path-jail used by directory-rooted FS backends (LocalFS, SpecFS).
// Resolves a caller-supplied relative path under an absolute root and refuses
// anything that would climb out. No `server-only`, no fs — unit-testable.

import path from "path";

/**
 * Resolve `relPath` under `root`, refusing escapes.
 * @throws if the resolved path is outside `root`.
 */
export function jailResolve(root: string, relPath: string): string {
  const clean = path.posix.normalize("/" + (relPath || "/")).replace(/^\/+/, "");
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Path escapes the filesystem root");
  }
  return abs;
}
