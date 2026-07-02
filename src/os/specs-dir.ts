import "server-only";
import path from "path";

// Container directory for spec stores (018-external-spec-store). Each spec store
// is an independent git repo living in a SUBDIRECTORY of this root; the root
// itself is a plain container, never a git repo. Kept out of the BOS source repo
// (gitignored when nested) so specs are distributable content, not source.
//
// Configurable via BOS_SPECS_ROOT (set it in .env.local), defaulting to
// <cwd>/specs — the same path the in-tree specs occupied before the migration.
export function specsRoot(): string {
  const override = process.env.BOS_SPECS_ROOT;
  return override && override.trim() ? override.trim() : path.join(process.cwd(), "specs");
}
