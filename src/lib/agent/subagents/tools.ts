import "server-only";
import * as vfs from "@/os/vfs";
import { fetchText } from "@/lib/net";
import * as repo from "@/lib/dev/repo-fs";
import { runDevCommand, ALLOWED_COMMANDS } from "@/lib/dev/run-command";
import * as git from "@/lib/system/git";
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
    description: "Create or overwrite a source file in the BrowserOS repository. Writes are allowed only under src/, spec/, public/, docs/, data/. src/ edits hot-reload in dev.",
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
  git_branch: {
    description: "Create or switch to a bos/<name> feature branch before modifying BOS (minimizes blast radius).",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute: async (input) => `On branch ${await git.createFeatureBranch(input.name as string)}`,
  },
  git_stage: {
    description: "Stage specific repo files (git add) so changes are tracked and reversible.",
    parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
    execute: async (input) => `Staged ${await git.stageFiles((input.paths as string[]) || [])} file(s)`,
  },
  git_status: {
    description: "Show the current git branch and changed files.",
    parameters: { type: "object", properties: {} },
    execute: async () => JSON.stringify(await git.status()),
  },
};

const ALL_TOOLS: Record<string, LlmTool> = { ...SUBAGENT_TOOLS, ...DEV_TOOLS };

/**
 * Resolve the tools a sub-agent may use. With no explicit allowlist an agent
 * gets only the safe base tools — never the repo-scoped DEV_TOOLS. A developer
 * agent opts into repo access by listing those tool ids in its `tools`.
 */
export function toolsFor(allowed?: string[]): Record<string, LlmTool> {
  if (!allowed || allowed.length === 0) return SUBAGENT_TOOLS;
  return Object.fromEntries(allowed.filter((id) => ALL_TOOLS[id]).map((id) => [id, ALL_TOOLS[id]]));
}
