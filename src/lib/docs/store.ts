import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { listInstalledItems } from "@/system/items/installed";

// The Docs app is a READ-ONLY viewer of the project documentation tree that
// lives in source control under `docs/` (NOT runtime state). Two audiences:
//   - docs/usage/** — end-user documentation
//   - docs/dev/**   — developer/agent documentation
// Authoring happens by editing those source files (via the developer sub-agent),
// so this module only reads. Under live-version-control a previewed candidate
// runs from its own worktree, so process.cwd()/docs resolves to that version's
// docs automatically.
//
// An INSTALLED ITEM ships its documentation with it, in the same two-audience
// shape (`<item>/docs/usage/<Name>/**`, `<item>/docs/dev/<Name>/**`), and this
// module OVERLAYS that onto the source tree at read time — one merged tree per
// audience, so an installed app's pages sit alongside BOS's own. Deliberately an
// overlay and not a symlink into `docs/`: installed state is ONE symlink at
// `system/<id>` (035-install-by-symlink), and a second install artifact planted
// inside the git-tracked source tree would dirty every worktree, be missing from
// every feature-branch worktree that didn't create it, and survive an uninstall
// that only removes the one link. Pre-035 there WAS such a symlink
// (`docs/external-docs/<id>`) — it had no reader at all, which is exactly the
// bug this replaces.

const DOCS_ROOT = path.join(process.cwd(), "docs");

export const SECTIONS = ["usage", "dev"] as const;
export type DocSection = (typeof SECTIONS)[number];

export function isSection(value: string): value is DocSection {
  return (SECTIONS as readonly string[]).includes(value);
}

// A node in the documentation tree: either a markdown page or a folder.
export interface DocNode {
  type: "file" | "dir";
  name: string; // path segment (e.g. "files.md" or "apps")
  path: string; // posix path relative to the section root (e.g. "apps/files.md")
  title: string; // display title
  children?: DocNode[]; // present for directories
}

export interface Doc {
  section: DocSection;
  path: string; // posix path relative to the section root
  title: string;
  content: string;
}

// Acronyms that should not be naively title-cased when prettifying a segment.
const ACRONYMS: Record<string, string> = {
  api: "API", mcp: "MCP", bos: "BOS", vfs: "VFS", ai: "AI", ui: "UI",
  os: "OS", llm: "LLM", ssr: "SSR", datafs: "DataFS", gitfs: "GitFS",
};

function prettify(segment: string): string {
  const base = segment.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  if (!base) return segment;
  return base
    .split(" ")
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Title a page by its first markdown H1; fall back to the prettified file name.
function headingOf(content: string): string | null {
  for (const line of content.split("\n", 60)) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

// Float overview/intro pages to the top of each level; the rest sort by title.
const PRIORITY = ["introduction", "architecture-overview", "overview", "index", "readme", "getting-started"];
function rank(node: DocNode): number {
  const base = node.name.replace(/\.md$/i, "").toLowerCase();
  const i = PRIORITY.indexOf(base);
  return i === -1 ? PRIORITY.length : i;
}
function compare(a: DocNode, b: DocNode): number {
  return rank(a) - rank(b) || a.title.localeCompare(b.title);
}

async function buildTree(absDir: string, relBase: string): Promise<DocNode[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
  const nodes: DocNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const children = await buildTree(path.join(absDir, entry.name), rel);
      if (children.length > 0) {
        nodes.push({ type: "dir", name: entry.name, path: rel, title: prettify(entry.name), children });
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const content = await fs.readFile(path.join(absDir, entry.name), "utf8").catch(() => "");
      nodes.push({ type: "file", name: entry.name, path: rel, title: headingOf(content) ?? prettify(entry.name) });
    }
  }
  return nodes.sort(compare);
}

// Every root that contributes pages to a section, in RESOLUTION ORDER: BOS's own
// docs/ tree first, then each installed item's `docs/<section>/`. Items are
// ordered by id so the merged tree is stable across requests, and BOS's own docs
// win any path collision — an item can extend the tree, never shadow it.
// A broken install (dangling symlink) contributes nothing.
async function sectionRoots(section: DocSection): Promise<string[]> {
  const items = await listInstalledItems().catch(() => []);
  return [
    path.join(DOCS_ROOT, section),
    ...items
      .filter((i) => i.facets.docs && !i.broken)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => path.join(i.itemPath, "docs", section)),
  ];
}

// Fold one root's nodes into the accumulated tree. Directories with the same
// path merge (so an item could add a page to an existing folder); a file that
// already exists at that path is dropped — the earlier root already provided it.
function mergeNodes(base: DocNode[], extra: DocNode[]): DocNode[] {
  if (extra.length === 0) return base;
  const byPath = new Map(base.map((n) => [n.path, n]));
  for (const node of extra) {
    const existing = byPath.get(node.path);
    if (!existing) {
      base.push(node);
      byPath.set(node.path, node);
    } else if (existing.type === "dir" && node.type === "dir") {
      existing.children = mergeNodes(existing.children ?? [], node.children ?? []);
    }
  }
  return base.sort(compare);
}

// The full documentation tree, keyed by audience section.
export async function docsTree(): Promise<Record<DocSection, DocNode[]>> {
  const out = {} as Record<DocSection, DocNode[]>;
  for (const section of SECTIONS) {
    let nodes: DocNode[] = [];
    for (const root of await sectionRoots(section)) {
      nodes = mergeNodes(nodes, await buildTree(root, ""));
    }
    out[section] = nodes;
  }
  return out;
}

// Resolve a section-relative path against ONE root, refusing traversal and
// anything outside that root or that is not a markdown file.
function resolveDocPath(sectionRoot: string, relPath: string): string | null {
  const cleaned = relPath.replace(/^[/\\]+/, "");
  const abs = path.resolve(sectionRoot, cleaned);
  if (abs !== sectionRoot && !abs.startsWith(sectionRoot + path.sep)) return null;
  if (!abs.toLowerCase().endsWith(".md")) return null;
  return abs;
}

export async function getDoc(section: DocSection, relPath: string): Promise<Doc | undefined> {
  // Same order the tree was built in, so a page always reads back from the root
  // the tree took it from.
  for (const root of await sectionRoots(section)) {
    const abs = resolveDocPath(root, relPath);
    if (!abs) continue;
    const content = await fs.readFile(abs, "utf8").catch(() => null);
    if (content == null) continue;
    const rel = relPath.replace(/^[/\\]+/, "").split(path.sep).join("/");
    return { section, path: rel, title: headingOf(content) ?? prettify(path.basename(abs)), content };
  }
  return undefined;
}

// Flattened list of every page across all sections (for the assistant's listDocs).
export async function listDocs(): Promise<{ section: DocSection; path: string; title: string }[]> {
  const tree = await docsTree();
  const out: { section: DocSection; path: string; title: string }[] = [];
  const walk = (section: DocSection, nodes: DocNode[]) => {
    for (const n of nodes) {
      if (n.type === "file") out.push({ section, path: n.path, title: n.title });
      else if (n.children) walk(section, n.children);
    }
  };
  for (const section of SECTIONS) walk(section, tree[section]);
  return out;
}
