// Unit tests for the installed-item documentation overlay on the /Docs VFS
// mount (src/os/fs/docs-fs.ts). src/lib/docs/store.ts already overlays an
// installed item's own docs onto the Docs app's tree (see
// tests/apps/item-docs-overlay.test.ts); DocsFS must apply the SAME overlay,
// or VFS-based tools (file_glob, file_search, the Files app) see a narrower
// /Docs than the Docs app UI shows — the item's documentation would then be
// unreachable through the VFS, which is supposed to be the canonical
// entrypoint for reading files.
//   npm run test:unit -- tests/apps/docs-fs-overlay.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, symlinkSync, writeFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { DocsFS } from "../../src/os/fs/docs-fs";

/** Install an item the only way installs are recorded: one `system/<id>`
 *  symlink to the item directory (035-install-by-symlink). */
function installItemWithFiles(dataDir: string, id: string, files: Record<string, string>): string {
  const itemPath = join(dataDir, "user-apps", "items", id);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(itemPath, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(itemPath, join(dataDir, "system", id));
  return itemPath;
}

test("DocsFS.list() surfaces an installed item's docs folder alongside BOS's own", async () => {
  const { dir, cleanup } = useTestDataDir("docs-fs-overlay-list");
  try {
    installItemWithFiles(dir, "workflows", {
      "docs/usage/Workflows/usage.md": "# Workflows\n\nHow to build one.\n",
    });

    const docsFs = new DocsFS();
    const usageEntries = await docsFs.list("usage");
    expect(usageEntries.some((e) => e.name === "Workflows" && e.type === "dir")).toBe(true);
    // BOS's own pages are still there — this is a merge, not a replacement.
    expect(usageEntries.some((e) => e.name === "introduction.md")).toBe(true);

    const workflowsEntries = await docsFs.list("usage/Workflows");
    expect(workflowsEntries.some((e) => e.name === "usage.md")).toBe(true);
  } finally {
    cleanup();
  }
});

test("DocsFS.readText()/exists() read an installed item's page", async () => {
  const { dir, cleanup } = useTestDataDir("docs-fs-overlay-read");
  try {
    installItemWithFiles(dir, "workflows", {
      "docs/usage/Workflows/usage.md": "# Workflows\n\nHow to build one.\n",
    });

    const docsFs = new DocsFS();
    expect(await docsFs.exists("usage/Workflows/usage.md")).toBe(true);
    expect(await docsFs.readText("usage/Workflows/usage.md")).toContain("How to build one.");
  } finally {
    cleanup();
  }
});

test("DocsFS.stat() reports the correct name for a merged section entry", async () => {
  const { dir, cleanup } = useTestDataDir("docs-fs-overlay-stat");
  try {
    installItemWithFiles(dir, "workflows", {
      "docs/usage/Workflows/usage.md": "# Workflows\n\nHow to build one.\n",
    });

    const docsFs = new DocsFS();
    const dirStat = await docsFs.stat("usage/Workflows");
    expect(dirStat.name).toBe("Workflows");
    expect(dirStat.type).toBe("dir");

    const fileStat = await docsFs.stat("usage/Workflows/usage.md");
    expect(fileStat.name).toBe("usage.md");
    expect(fileStat.type).toBe("file");
  } finally {
    cleanup();
  }
});

test("an installed item with no docs facet contributes nothing to DocsFS", async () => {
  const { dir, cleanup } = useTestDataDir("docs-fs-overlay-absent");
  try {
    installItemWithFiles(dir, "widgets", { "app/index.html": "<!doctype html>" });

    const docsFs = new DocsFS();
    const usageEntries = await docsFs.list("usage");
    expect(usageEntries.some((e) => e.name === "Widgets")).toBe(false);
  } finally {
    cleanup();
  }
});
