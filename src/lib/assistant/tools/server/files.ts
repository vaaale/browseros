import "server-only";
import type { AssistantTool, ToolContext } from "../../tools";
import { serverTool, parallel, schema, p } from "./util";
import * as vfs from "@/os/vfs";
import { withFeatureScope } from "@/lib/specs/feature-context";

// Server-side VFS editing/search tools (folds spec_patch/spec_edit/spec_search
// into generic file_* ops — any VFS path works, including the branch-coupled
// mounts /Specs and /Docs, since the mount's backend handles its own
// specialised behaviour transparently). Each call binds the conversation's
// active feature branch into scope before touching the VFS, so a write under
// a branch-coupled mount resolves the same way it would via the frontend
// file_write path (see fsClient.scoped in os-client.ts).

const MAX_SEARCH_RESULTS = 200;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_RESULTS = 200;
const MAX_GREP_LINE_LENGTH = 200;
const SEARCHABLE_EXT = new Set([
  ".md", ".markdown", ".txt", ".json", ".yml", ".yaml", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".html",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Roots of the REAL container filesystem, as an agent is likely to paste them
// into a file_* call (`/app/data/…`, `/data-clones/<branch>/…`, `/tmp/…`).
// This set is disjoint from every VFS root child (/Documents, /Pictures,
// /Desktop, /Specs, /Docs, /Methods, /workspace, …), so a strict
// first-segment match can never misfire on a genuine (even nonexistent) VFS
// path. Mirrors USER_PATH_PREFIX_RE in src/lib/self-heal/signature.ts —
// update both if the recognized container roots ever change.
const CONTAINER_ROOTS = new Set(["home", "users", "root", "app", "tmp", "var", "worktrees", "data-clones", "private"]);

/** True iff the path's first segment names a real container filesystem root —
 *  i.e. the caller handed a real on-disk path to a VFS-only tool. */
export function isRealContainerPath(path: string): boolean {
  const first = path.split("/").find((seg) => seg.length > 0);
  return first !== undefined && CONTAINER_ROOTS.has(first.toLowerCase());
}

/** The diagnostic for a VFS tool handed a real container path. A bare "no
 *  file at …" reads as a typo, so a capable agent just retries the identical
 *  wrong call (self-heal case 0026) — instead, say plainly that the namespace
 *  is wrong and name the tool that CAN reach the target. */
export function containerPathDiagnostic(path: string): string {
  const base =
    `'${path}' is a real on-disk container path, not a VFS path — the file_* tools only see the VFS ` +
    `(paths like /Documents/…, /Specs/…, /Docs/…).`;
  const item = /(?:^|\/)user-apps\/items\/([^/]+)\/(.+)$/.exec(path);
  if (item) {
    const artifact = item[2].replace(/^spec\//, "");
    return (
      `${base} This looks like a marketplace item's spec artifact: read it with ` +
      `app_spec_read('item-${item[1]}/${artifact}') (list artifacts with app_spec_list('item-${item[1]}')). ` +
      `For other real on-disk files, use run_command.`
    );
  }
  return `${base} To access real on-disk files, use run_command.`;
}

/** Shared guard for every VFS file tool: fail fast with the namespace
 *  diagnostic when the path is a real container path (which can never resolve
 *  in the VFS). Non-container paths — including genuinely missing VFS paths —
 *  pass through untouched and keep each tool's existing failure behaviour. */
function rejectContainerPath(path: string): void {
  if (isRealContainerPath(path)) throw new Error(containerPathDiagnostic(path));
}

function shorten(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Recursively enumerate every file path (not dirs) under `root`, via vfs.list
 *  (transparently follows mounted backends). Bounded by maxFiles so a huge
 *  subtree can't blow up a single tool call. */
async function walkFiles(root: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [root];
  while (queue.length && out.length < maxFiles) {
    const dir = queue.shift()!;
    const entries = await vfs.list(dir).catch(() => []);
    for (const e of entries) {
      if (e.type === "dir") queue.push(e.path);
      else out.push(e.path);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

/** Simple glob→RegExp: `**\/` = zero or more path segments (can vanish
 *  entirely, so `**\/*.md` also matches a file directly in the search root —
 *  standard "globstar" semantics), bare `**` = any chars including `/`, `*` =
 *  any chars except `/`, `?` = one char. Good enough for agent-authored
 *  patterns like `**\/*.md`. Intended to be tested against a path RELATIVE to
 *  the search root (see `relativeToRoot`) — a bare `*.md` has no `/`-crossing
 *  component, so it only matches a bare filename, never an absolute path. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += escapeRegExp(glob[i]);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Strip `root` (VFS-normalized) from an absolute VFS path returned by
 *  `walkFiles`, so a glob pattern is matched relative to the directory the
 *  caller searched under — matching what `path.str("Glob pattern, e.g.
 *  '**\/*.md'")` actually documents. Without this, every path tested is
 *  absolute (leading `/`), so a pattern with no `**` prefix (e.g. `*.md`)
 *  could never match anything, at any root, ever. */
function relativeToRoot(root: string, filePath: string): string {
  const normRoot = vfs.normalizeVfsPath(root);
  const prefix = normRoot === "/" ? "/" : `${normRoot}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath.replace(/^\/+/, "");
}

// The sandbox warning every CRUD description carries. These tools see ONLY
// data/vfs — the user's Documents/Pictures/Desktop plus the branch-coupled
// system mounts. They do NOT see BOS's own source, and an agent that believes
// otherwise hunts for src/ here, finds nothing, and concludes the code is
// missing. Stated once so the six can never drift apart on the point.
const SANDBOX = "This is the user's sandboxed data, NOT BrowserOS source code — to change BrowserOS itself, delegate to the developer sub-agent.";

/** `withFeatureScope` wrapper shared by every VFS tool in this module.
 *
 *  Binding the CALLING conversation's scope is what makes a write under a
 *  branch-coupled mount (/Specs, /Docs) resolve that conversation's active
 *  feature branch instead of the base checkout. It is not optional plumbing:
 *  without it SpecFS sees no active feature, and every /Specs write fails with
 *  SpecFSNoContextError while every /Specs read silently resolves to base —
 *  the branch's content simply invisible. Route each tool through this rather
 *  than repeating the call, so a tool added later cannot forget it. */
function inScope<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  return withFeatureScope({ conversationId: ctx.conversationId }, fn);
}

export function fileTools(): Record<string, AssistantTool> {
  return {
    // ---- VFS CRUD ---------------------------------------------------------
    // Server-executed since the move off the frontend tool path. They were
    // browser-dispatched purely for historical reasons (they predate the
    // server tool layer by two weeks), and the round-trip bought nothing: the
    // browser handler was a bare fetch to /api/fs, which is itself a thin
    // wrapper over these same vfs.* calls under the same feature scope.
    //
    // It cost something, though. A frontend tool cannot run without an
    // attached browser, so `headlessGate` stripped these from every headless
    // run — and a headless NAMED agent (Build Studio, self-heal) was then
    // structurally unable to create a file, while find_tools went on
    // advertising file_write as available. See docs/dev/file-tools/.

    file_list: parallel(serverTool(
      "file_list",
      `List entries in the user's virtual file system (Documents, Pictures, Desktop, and the mounted /Specs, /Docs and /Methods trees). ${SANDBOX}`,
      schema({ path: p.str('Directory path, defaults to "/"') }),
      async (input, ctx) =>
        inScope(ctx, async () => {
          const entries = await vfs.list(String(input.path ?? "") || "/");
          // `modified` is deliberately dropped: a per-call mtime turns every
          // listing into a cache-buster and pure diff noise in replay.
          return JSON.stringify(entries.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })));
        }),
    )),

    file_read: parallel(serverTool(
      "file_read",
      `Read a text file from the user's virtual file system. ${SANDBOX}`,
      schema({ path: p.str("File path") }, ["path"]),
      async (input, ctx) => inScope(ctx, () => vfs.readText(String(input.path ?? ""))),
    )),

    file_write: serverTool(
      "file_write",
      `Create or overwrite a text file in the user's virtual file system. Parent directories are created as needed. ${SANDBOX} Writing under /Specs or /Docs requires an active feature branch — call dev_branch_request first if none is set.`,
      schema({ path: p.str("File path"), content: p.str("File contents") }, ["path", "content"]),
      async (input, ctx) =>
        inScope(ctx, async () => {
          const path = String(input.path ?? "");
          await vfs.writeText(path, String(input.content ?? ""));
          return `Wrote ${path}.`;
        }),
    ),

    file_mkdir: serverTool(
      "file_mkdir",
      "Create a directory in the user's virtual file system, including any missing parents. Succeeds if it already exists.",
      schema({ path: p.str("Directory path") }, ["path"]),
      async (input, ctx) =>
        inScope(ctx, async () => {
          const path = String(input.path ?? "");
          await vfs.mkdir(path);
          return `Created folder ${path}.`;
        }),
    ),

    file_delete: serverTool(
      "file_delete",
      "Delete a file or folder (recursively) from the user's virtual file system.",
      schema({ path: p.str("Path to delete") }, ["path"]),
      async (input, ctx) =>
        inScope(ctx, async () => {
          const path = String(input.path ?? "");
          await vfs.remove(path);
          return `Deleted ${path}.`;
        }),
    ),

    file_rename: serverTool(
      "file_rename",
      "Rename or move a file or folder within the user's virtual file system. Both paths must be on the same side of a mount boundary — moving between /Specs and /Documents is refused.",
      schema({ path: p.str("Current path"), to: p.str("New path") }, ["path", "to"]),
      async (input, ctx) =>
        inScope(ctx, async () => {
          const path = String(input.path ?? "");
          const to = String(input.to ?? "");
          await vfs.rename(path, to);
          return `Renamed ${path} to ${to}.`;
        }),
    ),

    // ---- structural + search ----------------------------------------------

    file_edit: serverTool(
      "file_edit",
      "Replace a unique snippet of text in a VFS file (the search text must occur exactly once). Works on any VFS path, including /Specs/... and /Docs/... (which require an active feature branch to write — call dev_branch_request first if needed).",
      schema(
        { path: p.str("VFS path"), find: p.str("Exact text to find (must occur exactly once)"), replace: p.str("Replacement text") },
        ["path", "find", "replace"],
      ),
      async (input, ctx) =>
        withFeatureScope({ conversationId: ctx.conversationId }, async () => {
          const path = String(input.path ?? "");
          const find = String(input.find ?? "");
          const replace = String(input.replace ?? "");
          rejectContainerPath(path);
          const content = await vfs.readText(path);
          const count = content.split(find).length - 1;
          if (count === 0) throw new Error(`Text not found: "${shorten(find)}"`);
          if (count > 1) throw new Error(`Text matches ${count} times (must be unique): "${shorten(find)}"`);
          const idx = content.indexOf(find);
          const next = content.slice(0, idx) + replace + content.slice(idx + find.length);
          await vfs.writeText(path, next);
          return `Edited ${path}`;
        }),
    ),

    file_patch: serverTool(
      "file_patch",
      "Apply one or more targeted find/replace edits to a VFS file in a single atomic change. Each hunk's `find` must occur exactly once at the moment it applies; hunks apply in order (a later hunk sees earlier results). If any hunk fails, nothing is written. Works on any VFS path, including /Specs/... and /Docs/... (which require an active feature branch to write).",
      schema(
        {
          path: p.str("VFS path"),
          hunks: {
            type: "array",
            description: "Ordered edits; each replaces the single occurrence of `find` with `replace`.",
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "Exact text to find (must be unique when this hunk applies)" },
                replace: { type: "string", description: "Replacement text" },
              },
              required: ["find", "replace"],
            },
          },
        },
        ["path", "hunks"],
      ),
      async (input, ctx) =>
        withFeatureScope({ conversationId: ctx.conversationId }, async () => {
          const path = String(input.path ?? "");
          const hunks = (input.hunks as Array<{ find: string; replace: string }>) ?? [];
          rejectContainerPath(path);
          let content = await vfs.readText(path);
          for (const { find, replace } of hunks) {
            const count = content.split(find).length - 1;
            if (count !== 1) {
              throw new Error(
                count === 0 ? `Hunk not found: "${shorten(find)}"` : `Hunk matches ${count} times (must be unique): "${shorten(find)}"`,
              );
            }
            const idx = content.indexOf(find);
            content = content.slice(0, idx) + replace + content.slice(idx + find.length);
          }
          await vfs.writeText(path, content);
          return `Patched ${path} (${hunks.length} hunk${hunks.length === 1 ? "" : "s"})`;
        }),
    ),

    file_search: parallel(serverTool(
      "file_search",
      "Search file content for a literal string under a VFS directory (optionally filtered by a glob). Returns matching path:line:text. Works across mounted filesystems too (e.g. /Specs, /Docs).",
      schema(
        {
          path: p.str("VFS directory to search under"),
          query: p.str("Literal substring to search for (case-insensitive)"),
          glob: p.str("Optional glob to filter files, e.g. '**/*.md'"),
        },
        ["path", "query"],
      ),
      async (input, ctx) =>
        withFeatureScope({ conversationId: ctx.conversationId }, async () => {
          const root = String(input.path ?? "/");
          const query = String(input.query ?? "").toLowerCase();
          const glob = input.glob ? globToRegExp(String(input.glob)) : null;
          rejectContainerPath(root); // otherwise walkFiles silently yields []
          const files = await walkFiles(root, 5000);
          const results: { path: string; line: number; text: string }[] = [];
          for (const file of files) {
            if (glob && !glob.test(relativeToRoot(root, file))) continue;
            const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
            if (!SEARCHABLE_EXT.has(ext)) continue;
            const content = await vfs.readText(file).catch(() => null);
            if (content == null) continue;
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query)) {
                results.push({ path: file, line: i + 1, text: lines[i].trim().slice(0, 200) });
                if (results.length >= MAX_SEARCH_RESULTS) return JSON.stringify(results);
              }
            }
          }
          return JSON.stringify(results);
        }),
    )),

    // file_search's counterpart for ONE named file (043-file-grep). file_search
    // is a subtree walk whose `path` must be a directory — pointing it at a file
    // silently yields [] (walkFiles swallows the readdir error), which is the
    // exact defect this tool fixes: a non-file target errors LOUDLY here, and
    // the one named file is searched regardless of extension (no SEARCHABLE_EXT
    // gate — the agent asked for THIS file).
    file_grep: parallel(serverTool(
      "file_grep",
      "Search ONE named VFS file for a literal substring (no regex) and return its matching lines as path:line:text with 1-based line numbers. Single file only — use file_search to search under a directory. Errors if the path is not a readable text file.",
      schema(
        {
          path: p.str("The single VFS file to search (a file path, not a directory)"),
          pattern: p.str("Literal substring to search for (matched exactly, no regex)"),
          ignoreCase: p.bool("Match case-insensitively (default: case-sensitive)"),
          context: p.num("Also return up to n lines before and after each match (default: 0)"),
        },
        ["path", "pattern"],
      ),
      async (input, ctx) =>
        withFeatureScope({ conversationId: ctx.conversationId }, async () => {
          const path = String(input.path ?? "");
          const pattern = String(input.pattern ?? "");
          const ignoreCase = Boolean(input.ignoreCase);
          const rawContext = Number(input.context ?? 0);
          const contextLines = Number.isFinite(rawContext) && rawContext > 0 ? Math.floor(rawContext) : 0;

          let st;
          try {
            st = await vfs.stat(path);
          } catch {
            rejectContainerPath(path);
            throw new Error(`no file at '${path}'`);
          }
          if (st.type === "dir") {
            throw new Error(`'${path}' is a directory, not a file — use file_search to search under a directory`);
          }
          let content: string;
          try {
            content = await vfs.readText(path);
          } catch (e) {
            throw new Error(`cannot read '${path}': ${(e as Error).message}`);
          }
          if (content.includes("\u0000")) {
            throw new Error(`'${path}' cannot be decoded as text (binary content)`);
          }

          const lines = content.split("\n");
          const needle = ignoreCase ? pattern.toLowerCase() : pattern;
          const matched: number[] = []; // 0-based indices of matching lines
          for (let i = 0; i < lines.length; i++) {
            const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
            if (hay.includes(needle)) matched.push(i);
          }

          const kept = matched.slice(0, MAX_GREP_RESULTS);
          const withheld = matched.length - kept.length;
          const isMatch = new Set(kept);
          const emit = new Set<number>();
          for (const i of kept) {
            const from = Math.max(0, i - contextLines);
            const to = Math.min(lines.length - 1, i + contextLines);
            for (let j = from; j <= to; j++) emit.add(j);
          }
          const clip = (s: string) => (s.length > MAX_GREP_LINE_LENGTH ? s.slice(0, MAX_GREP_LINE_LENGTH) + "…" : s);
          const matches = [...emit]
            .sort((a, b) => a - b)
            .map((i) => ({
              path,
              line: i + 1,
              text: clip(lines[i].trim()),
              ...(isMatch.has(i) ? {} : { context: true }),
            }));

          const payload: Record<string, unknown> = { path, matchCount: matched.length, matches };
          if (matched.length === 0) payload.message = `No matches for "${shorten(pattern)}" in ${path}`;
          if (withheld > 0) {
            payload.truncated = `Truncated: showing the first ${MAX_GREP_RESULTS} of ${matched.length} matching lines (${withheld} withheld).`;
          }
          return JSON.stringify(payload);
        }),
    )),

    // file_search / file_glob / file_grep are read-only VFS traversals —
    // parallel-safe. The mutating file tools above (file_edit / file_patch)
    // deliberately are NOT: two concurrent edits could target the same file.
    file_glob: parallel(serverTool(
      "file_glob",
      "Find files under a VFS directory matching a glob pattern (`**` = any path segments, `*` = any chars in a segment). Works across mounted filesystems too (e.g. /Specs, /Docs).",
      schema({ path: p.str("VFS directory to search under"), pattern: p.str("Glob pattern, e.g. '**/*.md'") }, ["path", "pattern"]),
      async (input, ctx) =>
        withFeatureScope({ conversationId: ctx.conversationId }, async () => {
          const root = String(input.path ?? "/");
          const re = globToRegExp(String(input.pattern ?? "**"));
          rejectContainerPath(root); // otherwise walkFiles silently yields []
          const files = await walkFiles(root, 20000);
          const matches = files.filter((f) => re.test(relativeToRoot(root, f))).slice(0, MAX_GLOB_RESULTS);
          return JSON.stringify(matches);
        }),
    )),
  };
}
