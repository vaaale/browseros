import "server-only";
import { promises as fs } from "fs";
import path from "path";

// The Docs app is a READ-ONLY viewer of the project documentation tree that
// lives in source control under `docs/` (NOT runtime state). Two audiences:
//   - docs/usage/** — end-user documentation
//   - docs/dev/**   — developer/agent documentation
// Authoring happens by editing those source files (via the developer sub-agent),
// so this module only reads. Under live-version-control a previewed candidate
// runs from its own worktree, so process.cwd()/docs resolves to that version's
// docs automatically.

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

// The full documentation tree, keyed by audience section.
export async function docsTree(): Promise<Record<DocSection, DocNode[]>> {
  const out = {} as Record<DocSection, DocNode[]>;
  for (const section of SECTIONS) {
    out[section] = await buildTree(path.join(DOCS_ROOT, section), "");
  }
  return out;
}

// Resolve a section-relative path to an absolute path, refusing traversal and
// anything outside the section root or that is not a markdown file.
function resolveDocPath(section: DocSection, relPath: string): string | null {
  const sectionRoot = path.join(DOCS_ROOT, section);
  const cleaned = relPath.replace(/^[/\\]+/, "");
  const abs = path.resolve(sectionRoot, cleaned);
  if (abs !== sectionRoot && !abs.startsWith(sectionRoot + path.sep)) return null;
  if (!abs.toLowerCase().endsWith(".md")) return null;
  return abs;
}

export async function getDoc(section: DocSection, relPath: string): Promise<Doc | undefined> {
  const abs = resolveDocPath(section, relPath);
  if (!abs) return undefined;
  const content = await fs.readFile(abs, "utf8").catch(() => null);
  if (content == null) return undefined;
  const rel = relPath.replace(/^[/\\]+/, "").split(path.sep).join("/");
  return { section, path: rel, title: headingOf(content) ?? prettify(path.basename(abs)), content };
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
