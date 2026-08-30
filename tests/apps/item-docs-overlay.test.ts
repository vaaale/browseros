// Unit tests for the installed-item documentation overlay
// (src/lib/docs/store.ts). An item ships its own docs INSIDE the item
// (`<item>/docs/usage/<Name>/`, `<item>/docs/dev/<Name>/`), and the Docs app's
// tree/read API merges them onto BOS's own two trees at read time — there is no
// symlink into the git-tracked `docs/` source tree, and pre-035 the symlink
// there was (`docs/external-docs/<id>`) had no reader at all, which is why an
// installed app's documentation was simply invisible.
//   npm run test:unit -- tests/apps/item-docs-overlay.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, symlinkSync, writeFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { docsTree, getDoc } from "../../src/lib/docs/store";
import type { DocNode } from "../../src/lib/docs/store";

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

const find = (nodes: DocNode[], path: string): DocNode | undefined =>
  nodes.reduce<DocNode | undefined>((hit, n) => hit ?? (n.path === path ? n : n.children ? find(n.children, path) : undefined), undefined);

test("an installed item's docs appear in BOTH audience trees, alongside BOS's own", async () => {
  const { dir, cleanup } = useTestDataDir("item-docs-overlay");
  try {
    installItemWithFiles(dir, "widgets", {
      "app/index.html": "<!doctype html>",
      "docs/usage/Widgets/getting-started.md": "# Using Widgets\n\nClick the thing.\n",
      "docs/dev/Widgets/architecture.md": "# Widgets architecture\n",
    });

    const tree = await docsTree();

    expect(find(tree.usage, "Widgets")?.type).toBe("dir");
    expect(find(tree.usage, "Widgets/getting-started.md")?.title).toBe("Using Widgets");
    expect(find(tree.dev, "Widgets/architecture.md")?.title).toBe("Widgets architecture");
    // BOS's own pages are still there — this is a merge, not a replacement.
    expect(find(tree.usage, "introduction.md")).toBeTruthy();
  } finally {
    cleanup();
  }
});

test("an item page reads back through getDoc", async () => {
  const { dir, cleanup } = useTestDataDir("item-docs-read");
  try {
    installItemWithFiles(dir, "widgets", { "docs/usage/Widgets/getting-started.md": "# Using Widgets\n\nClick the thing.\n" });

    const doc = await getDoc("usage", "Widgets/getting-started.md");
    expect(doc?.content).toContain("Click the thing.");
    expect(doc?.title).toBe("Using Widgets");
    // Traversal out of the section root is refused for item roots too.
    expect(await getDoc("usage", "../dev/Widgets/architecture.md")).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("BOS's own docs win a path collision — an item can extend the tree, never shadow it", async () => {
  const { dir, cleanup } = useTestDataDir("item-docs-collision");
  try {
    installItemWithFiles(dir, "widgets", { "docs/usage/introduction.md": "# Hijacked\n" });

    const doc = await getDoc("usage", "introduction.md");
    expect(doc?.content).not.toContain("Hijacked");
    expect(find((await docsTree()).usage, "introduction.md")?.title).not.toBe("Hijacked");
  } finally {
    cleanup();
  }
});

test("a broken install contributes nothing and does not throw", async () => {
  const { dir, cleanup } = useTestDataDir("item-docs-broken");
  try {
    mkdirSync(join(dir, "system"), { recursive: true });
    symlinkSync(join(dir, "user-apps", "items", "gone"), join(dir, "system", "gone"));

    const tree = await docsTree();
    expect(find(tree.usage, "introduction.md")).toBeTruthy();
  } finally {
    cleanup();
  }
});

test("an installed item with no docs facet contributes nothing", async () => {
  const { dir, cleanup } = useTestDataDir("item-docs-absent");
  try {
    installItemWithFiles(dir, "widgets", { "app/index.html": "<!doctype html>" });

    expect(find((await docsTree()).usage, "Widgets")).toBeUndefined();
  } finally {
    cleanup();
  }
});
