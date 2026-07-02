import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";
import { listStores, getStore, type SpecStore } from "@/lib/specs/stores";
import { beginCandidate, commitOnSave } from "@/lib/specs/store-git";
import { ensureStoresOnce } from "@/lib/specs/seed";

// Multi-root spec filesystem (018-external-spec-store). A spec-fs path is
// `<storeId>/<relPath>`: the first segment selects a discovered spec store and
// the remainder is jailed to that store's root. Reads span all stores; a write to
// a non-writable store is refused, and a write to a store that requires promote is
// routed onto its candidate branch (edits accumulate there until promoted). Build
// Studio authors specs here and can never reach BOS source or secrets.

const MAX_READ_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 200;
const SEARCH_TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".yml", ".yaml"]);

export interface SpecEntry {
  name: string;
  /** Store-prefixed path, e.g. "bos-system-specs/001-build-studio/spec.md". */
  path: string;
  type: "dir" | "file";
  size: number;
}

function splitStorePath(p: string): { storeId: string; rel: string } {
  const norm = path.posix.normalize((p ?? "").replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!norm || norm === ".") return { storeId: "", rel: "" };
  const [storeId, ...rest] = norm.split("/");
  return { storeId: storeId || "", rel: rest.join("/") };
}

async function resolveInStore(p: string): Promise<{ store: SpecStore; rel: string; abs: string }> {
  await ensureStoresOnce();
  const { storeId, rel } = splitStorePath(p);
  const store = await getStore(storeId);
  if (!store) throw new Error(`Unknown spec store "${storeId}". Prefix paths with a store id (e.g. "bos-system-specs/...").`);
  const abs = path.resolve(store.root, rel);
  if (abs !== store.root && !abs.startsWith(store.root + path.sep)) {
    throw new Error(`Path escapes the store root: ${p}`);
  }
  return { store, rel, abs };
}

/** The active stores as top-level entries (a bare listDir("") lists them). */
export async function listStoreEntries(): Promise<SpecEntry[]> {
  await ensureStoresOnce();
  const stores = await listStores();
  return stores.map((s) => ({ name: s.id, path: s.id, type: "dir" as const, size: 0 }));
}

export async function listDir(p = ""): Promise<SpecEntry[]> {
  const { storeId } = splitStorePath(p);
  if (!storeId) return listStoreEntries();
  const { store, rel, abs } = await resolveInStore(p);
  const names = await fs.readdir(abs, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  const out: SpecEntry[] = [];
  for (const d of names) {
    if (d.name.startsWith(".")) continue;
    const childRel = path.posix.join(rel, d.name);
    const childPath = path.posix.join(store.id, childRel);
    let size = 0;
    if (d.isFile()) {
      try {
        size = (await fs.stat(path.join(abs, d.name))).size;
      } catch {
        /* ignore */
      }
    }
    out.push({ name: d.name, path: childPath, type: d.isDirectory() ? "dir" : "file", size });
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

export async function exists(p: string): Promise<boolean> {
  try {
    const { abs } = await resolveInStore(p);
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function readFile(p: string): Promise<string> {
  const { store, rel, abs } = await resolveInStore(p);
  const buf = await fs.readFile(abs);
  if (buf.byteLength > MAX_READ_BYTES) {
    return buf.subarray(0, MAX_READ_BYTES).toString("utf8") + `\n…[truncated at ${MAX_READ_BYTES} bytes of ${store.id}/${rel}]`;
  }
  return buf.toString("utf8");
}

/** Ensure a store is ready to receive a write, or throw with a clear reason.
 *  Stores that require promote are switched onto their candidate branch first. */
async function prepareWrite(store: SpecStore): Promise<void> {
  if (!store.writable) {
    throw new Error(`Spec store "${store.id}" is read-only (${store.owner}); it cannot be edited here.`);
  }
  if (store.requiresPromote) await beginCandidate(store.root);
}

export async function writeFile(p: string, content: string): Promise<string> {
  const { store, rel, abs } = await resolveInStore(p);
  await prepareWrite(store);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, content ?? "");
  await commitOnSave(store.root, `spec: write ${rel}`);
  return `${store.id}/${rel}`;
}

/** Replace the single occurrence of `find` with `replace` in a spec artifact. */
export async function editFile(p: string, find: string, replace: string): Promise<string> {
  const { store, rel, abs } = await resolveInStore(p);
  await prepareWrite(store);
  const src = await fs.readFile(abs, "utf8");
  const idx = src.indexOf(find);
  if (idx === -1) throw new Error(`The search text was not found in ${store.id}/${rel}.`);
  if (src.indexOf(find, idx + find.length) !== -1) {
    throw new Error(`The search text appears more than once in ${store.id}/${rel}; add surrounding context to make it unique.`);
  }
  await writeFileAtomic(abs, src.slice(0, idx) + (replace ?? "") + src.slice(idx + find.length));
  await commitOnSave(store.root, `spec: edit ${rel}`);
  return `${store.id}/${rel}`;
}

// The spec-kit ENGINE (templates + command prompts) stays in the BOS source tree
// at `.specify/templates` — it is not spec content, so it does not move into a
// store. Expose it READ-ONLY so Build Studio can still build artifact bodies from
// the templates without reaching arbitrary source.
const TEMPLATES_ROOT = path.join(process.cwd(), ".specify", "templates");

function resolveTemplate(rel: string): string {
  const norm = path.posix.normalize((rel ?? "").replace(/\\/g, "/")).replace(/^\/+/, "");
  const abs = path.resolve(TEMPLATES_ROOT, norm);
  if (abs !== TEMPLATES_ROOT && !abs.startsWith(TEMPLATES_ROOT + path.sep)) {
    throw new Error(`Path escapes the templates root: ${rel}`);
  }
  return abs;
}

export async function readTemplate(rel: string): Promise<string> {
  return fs.readFile(resolveTemplate(rel), "utf8");
}

export async function listTemplates(rel = ""): Promise<SpecEntry[]> {
  const abs = resolveTemplate(rel);
  const names = await fs.readdir(abs, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  return names
    .filter((d) => !d.name.startsWith("."))
    .map((d) => ({ name: d.name, path: path.posix.join(rel, d.name), type: d.isDirectory() ? "dir" : "file", size: 0 }));
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** Search text files across all stores (or one store subtree via `dir`). */
export async function search(query: string, opts?: { dir?: string; caseSensitive?: boolean }): Promise<SearchHit[]> {
  if (!query) return [];
  await ensureStoresOnce();
  const needle = opts?.caseSensitive ? query : query.toLowerCase();
  const hits: SearchHit[] = [];

  async function walk(absDir: string, relPath: string): Promise<void> {
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
      const childRel = path.posix.join(relPath, e.name);
      if (e.isDirectory()) {
        await walk(path.join(absDir, e.name), childRel);
      } else if (SEARCH_TEXT_EXT.has(path.extname(e.name))) {
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
            hits.push({ path: childRel, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (hits.length >= MAX_SEARCH_RESULTS) return;
          }
        }
      }
    }
  }

  if (opts?.dir) {
    const { store, rel, abs } = await resolveInStore(opts.dir);
    await walk(abs, path.posix.join(store.id, rel));
  } else {
    for (const store of await listStores()) {
      await walk(store.root, store.id);
    }
  }
  return hits;
}
