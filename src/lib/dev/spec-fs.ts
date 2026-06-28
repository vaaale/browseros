import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";

// Spec-scoped filesystem for Build Studio. Unlike repo-fs (the whole BOS source)
// or the VFS (data/vfs), this is jailed to the specification trees only:
//   - specs/      the per-feature spec-kit artifacts
//   - .specify/   templates, command prompts, and memory/constitution.md
// Build Studio authors specs here and can never reach BOS source or secrets.

const ROOT = process.cwd();
const ALLOW_PREFIXES = ["specs/", ".specify/"];

const MAX_READ_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 200;
const SEARCH_TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".yml", ".yaml"]);

function toRel(p: string): string {
  let rel = (p ?? "").trim();
  if (path.isAbsolute(rel)) rel = path.relative(ROOT, rel);
  rel = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\/+/, "");
  return rel;
}

function inJail(rel: string): boolean {
  return ALLOW_PREFIXES.some((pre) => rel === pre.replace(/\/$/, "") || rel.startsWith(pre));
}

function resolveInJail(p: string): { rel: string; abs: string } {
  const rel = toRel(p);
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`Path escapes the repo root: ${p}`);
  }
  if (!inJail(rel)) {
    throw new Error(`Path "${rel}" is outside the spec jail. Allowed: ${ALLOW_PREFIXES.join(", ")}.`);
  }
  return { rel, abs };
}

export interface SpecEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
}

export async function listDir(p = "specs"): Promise<SpecEntry[]> {
  const { rel, abs } = resolveInJail(p || "specs");
  const names = await fs.readdir(abs, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  const out: SpecEntry[] = [];
  for (const d of names) {
    if (d.name.startsWith(".")) continue;
    const childRel = path.posix.join(rel, d.name);
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

export async function exists(p: string): Promise<boolean> {
  try {
    const { abs } = resolveInJail(p);
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function readFile(p: string): Promise<string> {
  const { rel, abs } = resolveInJail(p);
  const buf = await fs.readFile(abs);
  if (buf.byteLength > MAX_READ_BYTES) {
    return buf.subarray(0, MAX_READ_BYTES).toString("utf8") + `\n…[truncated at ${MAX_READ_BYTES} bytes of ${rel}]`;
  }
  return buf.toString("utf8");
}

export async function writeFile(p: string, content: string): Promise<string> {
  const { rel, abs } = resolveInJail(p);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, content ?? "");
  return rel;
}

/** Replace the single occurrence of `find` with `replace` in a file. */
export async function editFile(p: string, find: string, replace: string): Promise<string> {
  const { rel, abs } = resolveInJail(p);
  const src = await fs.readFile(abs, "utf8");
  const idx = src.indexOf(find);
  if (idx === -1) throw new Error(`The search text was not found in ${rel}.`);
  if (src.indexOf(find, idx + find.length) !== -1) {
    throw new Error(`The search text appears more than once in ${rel}; add surrounding context to make it unique.`);
  }
  await writeFileAtomic(abs, src.slice(0, idx) + (replace ?? "") + src.slice(idx + find.length));
  return rel;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export async function search(query: string, opts?: { dir?: string; caseSensitive?: boolean }): Promise<SearchHit[]> {
  if (!query) return [];
  const start = resolveInJail(opts?.dir || "specs");
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
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
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
