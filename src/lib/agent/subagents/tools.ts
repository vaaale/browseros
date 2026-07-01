import "server-only";
import * as vfs from "@/os/vfs";
import { fetchText } from "@/lib/net";
import { webSearch, formatWebSearchForModel } from "@/lib/agent/web-search";
import * as repo from "@/lib/dev/repo-fs";
import { runDevCommand, ALLOWED_COMMANDS } from "@/lib/dev/run-command";
import * as git from "@/lib/system/git";
import * as specfs from "@/lib/dev/spec-fs";
import type { LlmTool } from "@/lib/agent/llm";

// Base tools every sub-agent may use: the sandboxed virtual file system + web.
export const SUBAGENT_TOOLS: Record<string, LlmTool> = {
  list_files: {
    description: "List entries in a virtual file system directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: 'Directory, defaults to "/"' } } },
    execute: async (input) => JSON.stringify(await vfs.list((input.path as string) || "/")),
  },
  read_file: {
    description: "Read a text file from the virtual file system.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => vfs.readText(input.path as string),
  },
  write_file: {
    description: "Create or overwrite a text file in the virtual file system.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    execute: async (input) => {
      await vfs.writeText(input.path as string, (input.content as string) ?? "");
      return `Wrote ${input.path}`;
    },
  },
  create_folder: {
    description: "Create a directory in the virtual file system.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => {
      await vfs.mkdir(input.path as string);
      return `Created ${input.path}`;
    },
  },
  web_fetch: {
    description: "Fetch a web page and return its readable text content.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    execute: async (input) => fetchText(input.url as string),
  },
  web_search: {
    description: "Search the web using Anthropic native web search. Use for current facts and cite returned source URLs.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, 2-1000 characters." },
        allowed_domains: { type: "array", items: { type: "string" }, description: "Optional domain allowlist. Do not combine with blocked_domains." },
        blocked_domains: { type: "array", items: { type: "string" }, description: "Optional domain blocklist. Do not combine with allowed_domains." },
      },
      required: ["query"],
    },
    execute: async (input) => formatWebSearchForModel(await webSearch({
      query: input.query as string,
      allowed_domains: input.allowed_domains as string[] | undefined,
      blocked_domains: input.blocked_domains as string[] | undefined,
    })),
  },
};

// Repo-scoped developer tools: these operate on the actual BrowserOS source so a
// developer sub-agent can modify BOS itself. Powerful, so they are NOT part of
// the default tool set — an agent must opt in by listing them in its `tools`.
export const DEV_TOOLS: Record<string, LlmTool> = {
  list_source: {
    description: "List files/folders in the BrowserOS source repository (relative to repo root, e.g. 'src/components').",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repo-relative dir, defaults to '.'" } } },
    execute: async (input) => JSON.stringify(await repo.listDir((input.path as string) || ".")),
  },
  read_source: {
    description: "Read a source file from the BrowserOS repository (repo-relative path, e.g. 'src/components/apps/settings/SkillsTab.tsx').",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => repo.readFile(input.path as string),
  },
  search_source: {
    description: "Search BrowserOS source files for a string. Returns matching path:line:text. Optionally restrict to a subdirectory.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, dir: { type: "string", description: "Subdir to search, defaults to 'src'" } },
      required: ["query"],
    },
    execute: async (input) => JSON.stringify(await repo.search(input.query as string, { dir: input.dir as string | undefined })),
  },
  write_source: {
    description: "Create or overwrite a source file in the BrowserOS repository. Writes are allowed only under src/, specs/, public/, docs/, data/. src/ edits hot-reload in dev.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    execute: async (input) => `Wrote ${await repo.writeFile(input.path as string, (input.content as string) ?? "")}`,
  },
  edit_source: {
    description: "Replace a unique snippet of text in a source file with new text (the search text must occur exactly once).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
    },
    execute: async (input) => `Edited ${await repo.editFile(input.path as string, input.find as string, (input.replace as string) ?? "")}`,
  },
  run_command: {
    description: `Run an allowlisted verification command and return its output. Allowed: ${ALLOWED_COMMANDS.join(", ")}.`,
    parameters: { type: "object", properties: { command: { type: "string", enum: ALLOWED_COMMANDS } }, required: ["command"] },
    execute: async (input) => {
      const r = await runDevCommand(input.command as string);
      return `[${r.command}] ${r.ok ? "OK" : `FAILED (exit ${r.exitCode})`}\n${r.output}`;
    },
  },
  // NOTE: git_branch / git_stage were removed. Under the Supervisor the live
  // checkout is the running base; branching/staging it breaks the running version
  // and blocks promote. The Supervisor owns version branches and commits the
  // developer's edits on the isolated preview worktree automatically — sub-agents
  // must NOT run git against the main checkout (specs/005, 017 diagnosis).
  git_status: {
    description: "Show the current git branch and changed files.",
    parameters: { type: "object", properties: {} },
    execute: async () => JSON.stringify(await git.status()),
  },
};

// Spec-scoped tools for Build Studio: read/write specification artifacts confined
// to specs/ + .specify/ (never BOS source). Opt-in like DEV_TOOLS — an agent must
// list them in its `tools`.
export const SPEC_TOOLS: Record<string, LlmTool> = {
  list_specs: {
    description: "List entries in the spec tree (under specs/ or .specify/). Defaults to 'specs'.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Dir under specs/ or .specify/, defaults to 'specs'" } } },
    execute: async (input) => JSON.stringify(await specfs.listDir((input.path as string) || "specs")),
  },
  read_spec: {
    description: "Read a specification artifact or template (path under specs/ or .specify/, e.g. 'specs/001-build-studio/spec.md' or '.specify/templates/spec-template.md').",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => specfs.readFile(input.path as string),
  },
  write_spec: {
    description: "Create or overwrite a specification artifact (path under specs/ or .specify/ ONLY). Build the body from the matching template in .specify/templates.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    execute: async (input) => `Wrote ${await specfs.writeFile(input.path as string, (input.content as string) ?? "")}`,
  },
  edit_spec: {
    description: "Replace a unique snippet of text in a spec artifact (the search text must occur exactly once).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
    },
    execute: async (input) => `Edited ${await specfs.editFile(input.path as string, input.find as string, (input.replace as string) ?? "")}`,
  },
  search_specs: {
    description: "Search the spec tree for a string. Returns matching path:line:text. Optionally restrict to a subdirectory.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, dir: { type: "string", description: "Subdir to search, defaults to 'specs'" } },
      required: ["query"],
    },
    execute: async (input) => JSON.stringify(await specfs.search(input.query as string, { dir: input.dir as string | undefined })),
  },
};

// Build Studio delegates implementation to the Developer via this tool. The real
// implementation is built per-run in the sub-agent runner (it needs the parent
// event stream + a depth guard), so it is referenced here only by id.
export const DELEGATE_TO_DEVELOPER = "delegate_to_developer";

const ALL_TOOLS: Record<string, LlmTool> = { ...SUBAGENT_TOOLS, ...DEV_TOOLS, ...SPEC_TOOLS };

/**
 * Resolve the tools a sub-agent may use. With no explicit allowlist an agent
 * gets only the safe base tools — never the repo-scoped DEV_TOOLS. A developer
 * agent opts into repo access by listing those tool ids in its `tools`.
 */
export function toolsFor(allowed?: string[]): Record<string, LlmTool> {
  if (!allowed || allowed.length === 0) return SUBAGENT_TOOLS;
  return Object.fromEntries(allowed.filter((id) => ALL_TOOLS[id]).map((id) => [id, ALL_TOOLS[id]]));
}
