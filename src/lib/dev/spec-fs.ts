import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";
import { listStores, getStore, STORE_MANIFEST, PROJECT_MANIFEST, type SpecStore } from "@/lib/specs/stores";
import { ITEM_STORE_PREFIX } from "@/lib/specs/item-stores";
import { commitOnSave, readFileAtBranch } from "@/lib/specs/store-git";
import { ensureStoresOnce } from "@/lib/specs/seed";
import { supervisorEnabled, supervisorBeginOrThrow } from "@/lib/devharness/supervisor";
import { logger } from "@/lib/logging/server-logger";
import { searchTerms, lineMatchesTerms } from "./text-search";

const COMPONENT = "dev-spec-fs";

// Multi-root spec filesystem (018-external-spec-store). A spec-fs path is
// `<storeId>/<relPath>`: the first segment selects a discovered spec store and
// the remainder is jailed to that store's root. Reads span all stores; a write to
// a non-writable store is refused.
//
// Branch coupling (020): every op takes an optional SpecCtx.branch — the SAME
// `bos/*` feature branch used for BOS's own source code. When one is active, ALL
// ops on a directory-scanned store target that branch's mounted spec-store
// worktree (`<codeWorktree>/specs/<storeId>`, provisioned via the Supervisor)
// instead of the base checkout — so specs land on the SAME branch/worktree the
// Developer works in (visible on disk immediately, and the commit advances the
// `bos/*` ref the tree's draft overlay reads). With no branch (or no Supervisor),
// ops use the base checkout and commit-on-save to its default branch. There is no
// separate per-Project git-activation mechanism (retired) — `user-specs` writes
// require a real feature branch precisely because a genuine BOS customization
// eventually needs code, and the spec should travel with it; `bos-system-specs`
// is never writable at all, branch or not (see `prepareWrite`).
//
// Item-owned stores (`owner: "item"`) obey the SAME rule, via the same feature
// branch. Their content lives in `data/user-apps`, which is itself a coupled
// repo (the Supervisor mounts it on the feature branch at
// `<previewDataDir>/user-apps`), so an item's spec travels with its app/service
// code and with BOS's own source, and promotes or discards as one operation.
// The mount root differs from a directory-scanned store's — user-apps is a
// different repo from the `<codeWorktree>/specs/<storeId>` mounts — which is
// the ONLY reason item stores get their own resolver (branchItemStoreRoot)
// rather than a separate policy. The former app-candidate mechanism, a second
// in-place branch scheme over the same repo, is retired.

const MAX_READ_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 200;
const SEARCH_TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".yml", ".yaml"]);

/** Context threaded through every spec op. `branch` (a `bos/*` feature branch)
 *  routes reads and writes to that branch's provisioned worktree spec store. */
export interface SpecCtx {
  branch?: string;
}

/** The specs container inside a feature branch's provisioned worktree.
 *  Idempotent: supervisorBeginOrThrow reuses an existing preview worktree.
 *  Checks the specific store's own subdirectory, not just the shared
 *  `specs/` container — the container exists as soon as ANY store mounts
 *  into it, so checking only that would silently treat one store's
 *  successful mount as proof every store mounted.
 *
 *  With `storeId`: a caller passing it explicitly wants THAT store's
 *  content, so this THROWS (with the real cause — a Supervisor/git-auth
 *  failure, or that specific store's own mount error) rather than returning
 *  null when it's not available; a caller silently falling back to the base
 *  checkout on null would read stale content or, worse, write onto the
 *  store's default branch instead of the feature branch with no indication
 *  anything went wrong.
 *  Without `storeId` (search's cross-store use): returns null on ANY
 *  failure, since "no branch-specific search root yet" is a normal,
 *  low-stakes fallback (search still runs, just without narrowing to the
 *  branch) — the real cause is still logged so it's distinguishable from
 *  "branch not written to yet". */
async function branchSpecsRoot(branch: string, storeId?: string): Promise<string | null> {
  if (!branch || !supervisorEnabled()) return null;
  if (!storeId) {
    try {
      const { worktree } = await supervisorBeginOrThrow(branch);
      const specsDir = path.join(worktree, "specs");
      await fs.access(specsDir);
      return specsDir;
    } catch (err) {
      logger().warn(COMPONENT, "branchSpecsRoot failed for cross-store search; continuing without it", { branch, err: String(err) });
      return null;
    }
  }
  const { worktree, mountErrors } = await supervisorBeginOrThrow(branch);
  const specsDir = path.join(worktree, "specs");
  try {
    await fs.access(path.join(specsDir, storeId));
    return specsDir;
  } catch {
    const cause = mountErrors?.[storeId] ?? "mount did not complete for an unknown reason";
    throw new Error(`Store "${storeId}" is not mounted on branch "${branch}": ${cause}`);
  }
}

/** An ITEM-owned store's root on a feature branch: the item's `spec/` folder
 *  inside the branch-coupled `user-apps` worktree the Supervisor mounts in the
 *  preview's data clone. Throws rather than returning null for the same reason
 *  branchSpecsRoot does with an explicit storeId — a caller that passed a
 *  branch wants THAT branch's content, and quietly resolving to the base
 *  checkout would write onto the live default branch with no indication
 *  anything went wrong. */
async function branchItemStoreRoot(branch: string, storeId: string): Promise<string> {
  if (!storeId.startsWith(ITEM_STORE_PREFIX)) {
    // Guards the slice below: a non-prefixed id would silently yield a
    // truncated, wrong item directory rather than an error.
    throw new Error(`branchItemStoreRoot: "${storeId}" is not an item-owned store id.`);
  }
  const { dataDir } = await supervisorBeginOrThrow(branch);
  if (!dataDir) {
    throw new Error(`Supervisor returned no data clone for branch "${branch}"; cannot resolve item store "${storeId}" on it.`);
  }
  const userApps = path.join(dataDir, "user-apps");
  try {
    await fs.access(userApps);
  } catch (err) {
    // The real errno (ENOENT = never mounted, EACCES = a permissions problem
    // needing a different fix) is preserved rather than flattened away.
    logger().warn(COMPONENT, "user-apps mount missing for branch", { branch, storeId, userApps, err: String(err) });
    throw new Error(`user-apps is not mounted on branch "${branch}" (${(err as NodeJS.ErrnoException)?.code ?? "unknown"}); cannot edit item store "${storeId}" there.`);
  }
  const root = path.join(userApps, "items", storeId.slice(ITEM_STORE_PREFIX.length), "spec");
  logger().debug(COMPONENT, "resolved item store on branch", { branch, storeId, root });
  return root;
}

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

/** The Project id a store-relative path belongs to — its first segment — or
 *  undefined for a bare store-root path. Meaningless for item-owned stores
 *  (they have no Projects at all). Projects are pure organizational folders
 *  now (no independent activation semantics) — this is only used to enforce
 *  "writes must target a file inside a Project," not to look up any session. */
function projectIdOf(rel: string): string | undefined {
  return rel.split("/")[0] || undefined;
}

async function resolveInStore(p: string, ctx?: SpecCtx): Promise<{ store: SpecStore; rel: string; abs: string; root: string }> {
  await ensureStoresOnce();
  const { storeId, rel } = splitStorePath(p);
  const store = await getStore(storeId);
  if (!store) throw new Error(`Unknown spec store "${storeId}". Prefix paths with a store id (e.g. "bos-system-specs/...").`);
  // An item-owned store (item-stores.ts) routes to the branch-coupled
  // `user-apps` worktree, NOT to `<codeWorktree>/specs/<id>` — user-apps is a
  // different repo from the spec-store mounts, so resolving it the same way
  // would land the write in the wrong repo entirely. Hence a separate
  // resolver; the branch POLICY is identical to every other writable store.
  let root = store.root;
  if (store.owner === "item" && ctx?.branch && supervisorEnabled()) {
    root = await branchItemStoreRoot(ctx.branch, store.id);
  } else if (store.owner !== "item" && ctx?.branch && supervisorEnabled()) {
    // A caller passing ctx.branch explicitly wants THAT branch's content —
    // silently substituting the base checkout when its mount isn't ready
    // (Supervisor busy, or a per-store mount failure) would read stale/
    // missing content, or worse, WRITE straight onto the store's default
    // branch instead of the feature branch, with no indication anything went
    // wrong. Fail loudly instead; the caller can retry once the mount is up.
    // (With no Supervisor at all — standalone dev, or this file's own unit
    // tests — there is no worktree mechanism to route into at all, so this
    // check is skipped entirely and content lives in the base checkout, same
    // as always; branch-gating for THAT mode is enforced by prepareWrite.)
    // branchSpecsRoot throws (with the real cause) rather than returning
    // null when a storeId is passed — see its doc comment. The null check
    // below is unreachable in practice; it's here only to narrow the type.
    const wtSpecs = await branchSpecsRoot(ctx.branch, store.id);
    if (!wtSpecs) throw new Error(`Store "${store.id}" is not mounted on branch "${ctx.branch}"`);
    root = path.join(wtSpecs, store.id);
  }
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the store root: ${p}`);
  }
  return { store, rel, abs, root };
}

/** Resolve a store-prefixed path to its real absolute path on disk — for
 *  external callers that need a path to hand to a SEPARATE process (e.g. the
 *  headless Developer harness's own filesystem tools), not this module's own
 *  read/write API. Honors the same item-store / branch-worktree routing as
 *  every other op (resolveInStore). */
export async function resolveAbsolutePath(p: string, ctx?: SpecCtx): Promise<string> {
  const { abs } = await resolveInStore(p, ctx);
  return abs;
}

/** Resolve a store-prefixed path to its store + relative path WITHOUT any
 *  session/branch routing — for callers that need the store's own repo root
 *  regardless of which Project session (if any) is active, e.g. history
 *  browsing (037-project-layer), which reads the store's FULL git history
 *  across every branch, not just the currently active worktree. */
export async function resolveStoreRoot(p: string): Promise<{ store: SpecStore; rel: string }> {
  await ensureStoresOnce();
  const { storeId, rel } = splitStorePath(p);
  const store = await getStore(storeId);
  if (!store) throw new Error(`Unknown spec store "${storeId}". Prefix paths with a store id (e.g. "bos-system-specs/...").`);
  return { store, rel };
}

/** The active stores as top-level entries (a bare listDir("") lists them). */
export async function listStoreEntries(): Promise<SpecEntry[]> {
  await ensureStoresOnce();
  const stores = await listStores();
  return stores.map((s) => ({ name: s.id, path: s.id, type: "dir" as const, size: 0 }));
}

export async function listDir(p = "", ctx?: SpecCtx): Promise<SpecEntry[]> {
  const { storeId } = splitStorePath(p);
  if (!storeId) return listStoreEntries();
  const { store, rel, abs } = await resolveInStore(p, ctx);
  const names = await fs.readdir(abs, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  const out: SpecEntry[] = [];
  for (const d of names) {
    if (d.name.startsWith(".") || d.name === STORE_MANIFEST || d.name === PROJECT_MANIFEST) continue;
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

export async function exists(p: string, ctx?: SpecCtx): Promise<boolean> {
  try {
    const { abs } = await resolveInStore(p, ctx);
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function readFile(p: string, ctx?: SpecCtx): Promise<string> {
  const { store, rel, abs } = await resolveInStore(p, ctx);
  const buf = await fs.readFile(abs);
  if (buf.byteLength > MAX_READ_BYTES) {
    return buf.subarray(0, MAX_READ_BYTES).toString("utf8") + `\n…[truncated at ${MAX_READ_BYTES} bytes of ${store.id}/${rel}]`;
  }
  return buf.toString("utf8");
}

/** Ensure a store is ready to receive a write, or throw with a clear reason.
 *  A non-writable store (`bos-system-specs`) is refused outright, branch or
 *  not. EVERY writable store — directory-scanned and item-owned alike —
 *  requires a real feature branch (`ctx.branch`, the SAME `bos/*` branch used
 *  for BOS's own source; there is no separate per-Project activation, and no
 *  separate app-candidate for items anymore). The gate is unconditional: it
 *  does NOT depend on the Supervisor being present, matching the rule that
 *  only branch ROUTING is Supervisor-conditional (resolveInStore) while the
 *  branch REQUIREMENT never is — otherwise a standalone run would silently
 *  write live.
 *
 *  Directory-scanned stores additionally require a path inside a Project
 *  (Projects are pure organizational folders). Writing a Project's OWN
 *  manifest (`createProject()` in projects.ts) is exempt — a structural
 *  bootstrap action, not content, and requiring a branch just to create an
 *  empty folder to later put branch-gated content into would be pure
 *  friction. Item stores have no Projects, so only the branch rule applies. */
async function prepareWrite(store: SpecStore, rel: string, ctx?: SpecCtx): Promise<void> {
  if (!store.writable) {
    throw new Error(`Spec store "${store.id}" is read-only (${store.owner}); it cannot be edited here.`);
  }
  if (store.owner !== "item") {
    const projectId = projectIdOf(rel);
    if (!projectId) {
      throw new Error(`Cannot write directly to the root of store "${store.id}" — writes must target a file inside a Project.`);
    }
    if (rel === `${projectId}/${PROJECT_MANIFEST}`) return; // creating the Project itself
  }
  if (!ctx?.branch) {
    // Names the RECOVERY, not just the condition. A sub-agent that hits this
    // mid-run has no way to guess what to do otherwise: the observed failure
    // was an agent stalling while it searched its tool list for something that
    // would create a branch. Any agent whose tools include dev_branch_request
    // (routed to the user through the parent run — inner-loop.ts) can now
    // self-recover; one without it at least reports something its caller can
    // act on instead of spinning.
    throw new Error(
      `Store "${store.id}" needs an active feature branch before it can be edited. ` +
        `Call dev_branch_request (task = a one-line description of this work), wait for the user to confirm the branch name, then retry this exact write. ` +
        `Do not look for another tool and do not skip the write.`,
    );
  }
}

/** A store-relative path re-expressed relative to the store's GIT REPO root
 *  (`store.repoRoot`). Identity for a directory-scanned store, which is its own
 *  repo root; for an item-owned store it prefixes `items/<id>/spec/`, since
 *  that store's root is a subdirectory of the shared `user-apps` repo. Every
 *  git surface that addresses a path by REPO — `git log -- <path>`, and
 *  `git show <ref>:<path>`, which resolves against the repo root rather than
 *  the cwd — must go through this instead of using the store-relative path. */
export function storeRepoRelative(store: SpecStore, rel: string): string {
  return path.relative(store.repoRoot, path.join(store.root, rel)).split(path.sep).join("/");
}

/** Read a file's content at a draft branch of its store (no checkout). */
export async function readFileAt(p: string, branch: string): Promise<string> {
  const { store, rel } = await resolveInStore(p);
  return readFileAtBranch(store.repoRoot, branch, storeRepoRelative(store, rel));
}

export async function writeFile(p: string, content: string, ctx?: SpecCtx): Promise<string> {
  const { store, rel, abs, root } = await resolveInStore(p, ctx);
  await prepareWrite(store, rel, ctx);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, content ?? "");
  await commitOnSave(root, `spec: write ${rel}`);
  return `${store.id}/${rel}`;
}

/** Delete a spec file (gated the same as a write — an active session for
 *  directory-scanned stores, none required for item-owned stores). */
export async function remove(p: string, ctx?: SpecCtx): Promise<void> {
  const { store, rel, abs, root } = await resolveInStore(p, ctx);
  await prepareWrite(store, rel, ctx);
  await fs.rm(abs, { recursive: true, force: false });
  await commitOnSave(root, `spec: remove ${rel}`);
}

/** Rename/move a spec file within the same store (gated the same as a write). */
export async function rename(fromP: string, toP: string, ctx?: SpecCtx): Promise<string> {
  const from = await resolveInStore(fromP, ctx);
  const to = await resolveInStore(toP, ctx);
  if (from.store.id !== to.store.id) {
    throw new Error("Cannot rename a spec file across two different stores.");
  }
  await prepareWrite(from.store, from.rel, ctx);
  await prepareWrite(to.store, to.rel, ctx);
  await fs.mkdir(path.dirname(to.abs), { recursive: true });
  await fs.rename(from.abs, to.abs);
  await commitOnSave(from.root, `spec: rename ${from.rel} -> ${to.rel}`);
  return `${to.store.id}/${to.rel}`;
}

/** Replace the single occurrence of `find` with `replace` in a spec artifact. */
export async function editFile(p: string, find: string, replace: string, ctx?: SpecCtx): Promise<string> {
  const { store, rel, abs, root } = await resolveInStore(p, ctx);
  await prepareWrite(store, rel, ctx);
  const src = await fs.readFile(abs, "utf8");
  const idx = src.indexOf(find);
  if (idx === -1) throw new Error(`The search text was not found in ${store.id}/${rel}.`);
  if (src.indexOf(find, idx + find.length) !== -1) {
    throw new Error(`The search text appears more than once in ${store.id}/${rel}; add surrounding context to make it unique.`);
  }
  await writeFileAtomic(abs, src.slice(0, idx) + (replace ?? "") + src.slice(idx + find.length));
  await commitOnSave(root, `spec: edit ${rel}`);
  return `${store.id}/${rel}`;
}

export interface SpecHunk {
  find: string;
  replace: string;
}

/** Apply an ORDERED list of unique find/replace hunks to a spec artifact in ONE
 *  atomic write. Hunks apply sequentially (a later hunk sees earlier results);
 *  each `find` must occur exactly once at the moment it applies. If ANY hunk
 *  fails to match uniquely, NOTHING is written — a bad patch never leaves a
 *  partial edit. This is the surgical alternative to a wholesale writeFile. */
export async function patchFile(p: string, hunks: SpecHunk[], ctx?: SpecCtx): Promise<string> {
  const { store, rel, abs, root } = await resolveInStore(p, ctx);
  await prepareWrite(store, rel, ctx);
  if (!Array.isArray(hunks) || hunks.length === 0) {
    throw new Error("patch requires at least one { find, replace } hunk.");
  }
  let src = await fs.readFile(abs, "utf8");
  for (let i = 0; i < hunks.length; i++) {
    const find = hunks[i]?.find ?? "";
    const replace = hunks[i]?.replace ?? "";
    if (!find) throw new Error(`Hunk ${i + 1}: "find" must be non-empty.`);
    const idx = src.indexOf(find);
    if (idx === -1) throw new Error(`Hunk ${i + 1}: search text was not found in ${store.id}/${rel}.`);
    if (src.indexOf(find, idx + find.length) !== -1) {
      throw new Error(
        `Hunk ${i + 1}: search text appears more than once in ${store.id}/${rel}; add surrounding context to make it unique.`,
      );
    }
    src = src.slice(0, idx) + replace + src.slice(idx + find.length);
  }
  await writeFileAtomic(abs, src);
  await commitOnSave(root, `spec: patch ${rel}`);
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
export async function search(query: string, opts?: { dir?: string; caseSensitive?: boolean; branch?: string }): Promise<SearchHit[]> {
  if (!query) return [];
  await ensureStoresOnce();
  const terms = searchTerms(query, opts?.caseSensitive);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  // When a feature branch is active, search inside its worktree spec stores.
  const branchRoot = opts?.branch ? await branchSpecsRoot(opts.branch) : null;

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
          if (lineMatchesTerms(lines[i], terms, opts?.caseSensitive)) {
            hits.push({ path: childRel, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (hits.length >= MAX_SEARCH_RESULTS) return;
          }
        }
      }
    }
  }

  if (opts?.dir) {
    const { store, rel, abs } = await resolveInStore(opts.dir, opts.branch ? { branch: opts.branch } : undefined);
    await walk(abs, path.posix.join(store.id, rel));
  } else {
    for (const store of await listStores()) {
      const root = branchRoot ? path.join(branchRoot, store.id) : store.root;
      await walk(root, store.id);
    }
  }
  return hits;
}
