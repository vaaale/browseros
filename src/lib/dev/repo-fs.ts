import "server-only";
import { promises as fs } from "fs";
import path from "path";

// Repo-scoped filesystem for the developer sub-agent. Unlike the VFS (sandboxed
// to data/vfs), this operates on the actual BrowserOS source so the agent can
// modify BOS itself. It is deliberately fenced:
//   - every path is jailed to the repo root (no "..", no escapes);
//   - reads are denied for secrets, VCS, deps, and build output;
//   - writes are allowed only under known source directories.
// Edits to src/** are hot-reloaded by `next dev`; some changes need a restart.

const ROOT = process.cwd();

const READ_DENY: RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.env(\.[^/]+)?$/,
];

// Writes are confined to source/content trees; never package.json, lockfiles,
// next.config, .env, .git, etc. (which could break the build or leak secrets).
const WRITE_ALLOW_PREFIXES = ["src/", "specs/", ".specify/", "public/", "docs/", "data/"];

const MAX_READ_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 200;
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", ".next", "data"]);
const SEARCH_TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".md", ".mdx", ".txt", ".html", ".yml", ".yaml",
]);

function toRel(p: string): string {
  // Accept absolute repo paths or repo-relative paths; normalize to relative.
  let rel = p.trim();
  if (path.isAbsolute(rel)) rel = path.relative(ROOT, rel);
  rel = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\/+/, "");
  return rel;
}

function resolveInRepo(p: string): { rel: string; abs: string } {
  const rel = toRel(p);
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`Path escapes the repo root: ${p}`);
  }
  return { rel, abs };
}

function assertReadable(rel: string): void {
  if (READ_DENY.some((re) => re.test(rel))) {
    throw new Error(`Reading "${rel}" is not allowed (protected path).`);
  }
}

function assertWritable(rel: string): void {
  assertReadable(rel);
  if (!WRITE_ALLOW_PREFIXES.some((pre) => rel === pre.replace(/\/$/, "") || rel.startsWith(pre))) {
    throw new Error(
      `Writing "${rel}" is not allowed. Writes are confined to: ${WRITE_ALLOW_PREFIXES.join(", ")}.`,
    );
  }
}

export interface RepoEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
}

export async function listDir(p = "."): Promise<RepoEntry[]> {
  const { rel, abs } = resolveInRepo(p || ".");
  assertReadable(rel);
  const names = await fs.readdir(abs, { withFileTypes: true });
  const out: RepoEntry[] = [];
  for (const d of names) {
    const childRel = path.posix.join(rel, d.name);
    if (READ_DENY.some((re) => re.test(childRel))) continue;
    let size = 0;
    if (d.isFile()) {
      try {
        size = (await fs.stat(path.join(abs, d.name))).size;
      } catch {
        /* ignore */
      }
    }
    out.push({ name: d.name, path: childRel, type: d.isDirectory() ? "dir" : "file", size });
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

export async function readFile(p: string): Promise<string> {
  const { rel, abs } = resolveInRepo(p);
  assertReadable(rel);
  const buf = await fs.readFile(abs);
  if (buf.byteLength > MAX_READ_BYTES) {
    return buf.subarray(0, MAX_READ_BYTES).toString("utf8") + `\n…[truncated at ${MAX_READ_BYTES} bytes]`;
  }
  return buf.toString("utf8");
}

export async function writeFile(p: string, content: string): Promise<string> {
  const { rel, abs } = resolveInRepo(p);
  assertWritable(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return rel;
}

/** Replace the first occurrence of `find` with `replace` in a file. */
export async function editFile(p: string, find: string, replace: string): Promise<string> {
  const { rel, abs } = resolveInRepo(p);
  assertWritable(rel);
  const src = await fs.readFile(abs, "utf8");
  const idx = src.indexOf(find);
  if (idx === -1) throw new Error(`The search text was not found in ${rel}.`);
  if (src.indexOf(find, idx + find.length) !== -1) {
    throw new Error(`The search text appears more than once in ${rel}; include more surrounding context to make it unique.`);
  }
  await fs.writeFile(abs, src.slice(0, idx) + replace + src.slice(idx + find.length), "utf8");
  return rel;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export async function search(query: string, opts?: { dir?: string; caseSensitive?: boolean }): Promise<SearchHit[]> {
  if (!query) return [];
  const start = resolveInRepo(opts?.dir || "src");
  assertReadable(start.rel);
  const needle = opts?.caseSensitive ? query : query.toLowerCase();
  const hits: SearchHit[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (hits.length >= MAX_SEARCH_RESULTS) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= MAX_SEARCH_RESULTS) return;
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(path.join(absDir, e.name), path.posix.join(relDir, e.name));
      } else if (SEARCH_TEXT_EXT.has(path.extname(e.name))) {
        const relFile = path.posix.join(relDir, e.name);
        let content: string;
        try {
          content = await fs.readFile(path.join(absDir, e.name), "utf8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const hay = opts?.caseSensitive ? lines[i] : lines[i].toLowerCase();
          if (hay.includes(needle)) {
            hits.push({ path: relFile, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (hits.length >= MAX_SEARCH_RESULTS) return;
          }
        }
      }
    }
  }

  await walk(start.abs, start.rel);
  return hits;
}
