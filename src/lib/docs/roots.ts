import "server-only";
import path from "path";
import { listInstalledItems } from "@/system/items/installed";

// Shared between src/lib/docs/store.ts (the Docs app's /api/docs tree) and
// src/os/fs/docs-fs.ts (the /Docs VFS mount that backs file_glob/file_search/
// the Files app). Both need the SAME notion of "what roots contribute to a
// docs section" — an installed item ships its own `docs/usage/**` +
// `docs/dev/**` (035-install-by-symlink facet scan), and that content must be
// visible through whichever surface reads /Docs, not just the Docs app's own
// fetch path. See src/lib/docs/store.ts for the full rationale on why this is
// an overlay at read time rather than a symlink into the git-tracked docs/.

export const SECTIONS = ["usage", "dev"] as const;
export type DocSection = (typeof SECTIONS)[number];

export function isSection(value: string): value is DocSection {
  return (SECTIONS as readonly string[]).includes(value);
}

// Every root that contributes pages to a section, in RESOLUTION ORDER: the
// canonical docs/ tree first (BOS's own, or the caller's active worktree),
// then each installed item's `docs/<section>/`, sorted by id so the merged
// result is stable across requests. The canonical root wins any path
// collision — an item can extend a section, never shadow it. A broken
// install (dangling symlink) contributes nothing.
export async function sectionRoots(docsRoot: string, section: DocSection): Promise<string[]> {
  const items = await listInstalledItems().catch(() => []);
  return [
    path.join(docsRoot, section),
    ...items
      .filter((i) => i.facets.docs && !i.broken)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => path.join(i.itemPath, "docs", section)),
  ];
}
