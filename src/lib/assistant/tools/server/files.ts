import "server-only";
import type { AssistantTool } from "../../tools";
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
const SEARCHABLE_EXT = new Set([
  ".md", ".markdown", ".txt", ".json", ".yml", ".yaml", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".html",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function fileTools(): Record<string, AssistantTool> {
  return {
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

    // file_search / file_glob are read-only VFS traversals — parallel-safe.
    // The mutating file tools above (file_edit / file_patch) deliberately are
    // NOT: two concurrent edits could target the same file.
    file_glob: parallel(serverTool(
      "file_glob",
      "Find files under a VFS directory matching a glob pattern (`**` = any path segments, `*` = any chars in a segment). Works across mounted filesystems too (e.g. /Specs, /Docs).",
      schema({ path: p.str("VFS directory to search under"), pattern: p.str("Glob pattern, e.g. '**/*.md'") }, ["path", "pattern"]),
      async (input, ctx) =>
        withFeatureScope({ conversationId: ctx.conversationId }, async () => {
          const root = String(input.path ?? "/");
          const re = globToRegExp(String(input.pattern ?? "**"));
          const files = await walkFiles(root, 20000);
          const matches = files.filter((f) => re.test(relativeToRoot(root, f))).slice(0, MAX_GLOB_RESULTS);
          return JSON.stringify(matches);
        }),
    )),
  };
}
