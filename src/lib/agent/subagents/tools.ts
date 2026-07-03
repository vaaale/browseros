import "server-only";
import * as vfs from "@/os/vfs";
import { fetchText } from "@/lib/net";
import { webSearch, formatWebSearchForModel } from "@/lib/agent/web-search";
import * as repo from "@/lib/dev/repo-fs";
import * as git from "@/lib/system/git";
import * as specfs from "@/lib/dev/spec-fs";
import type { LlmTool } from "@/lib/agent/llm";
import { SCHEDULER_TOOLS } from "@/lib/scheduler/agent-tools";
import { listSkills, getSkill, readSkillFile, listSkillFiles } from "@/lib/agent/skills/store";

// Base tools every sub-agent may use: the sandboxed virtual file system, web,
// and scheduler operations (spread in at module bottom to keep this literal
// small; scheduler tools live in their own module).
export const SUBAGENT_TOOLS: Record<string, LlmTool> = {
  file_list: {
    description: "List entries in a virtual file system directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: 'Directory, defaults to "/"' } } },
    execute: async (input) => JSON.stringify(await vfs.list((input.path as string) || "/")),
  },
  file_read: {
    description: "Read a text file from the virtual file system.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => vfs.readText(input.path as string),
  },
  file_write: {
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
  file_mkdir: {
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
  // Skill library (progressive disclosure): list skills, load a skill's SKILL.md,
  // and read its bundled reference/script files. Part of every sub-agent's base
  // toolkit so delegated agents can actually follow the skills they load.
  skill_list: {
    description: "List available skills (id, name, description, when to use).",
    parameters: { type: "object", properties: {} },
    execute: async () =>
      JSON.stringify((await listSkills()).map((s) => ({ id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse }))),
  },
  skill_load: {
    description:
      "Load a skill's full instructions (SKILL.md) by name or id. The instructions may reference bundled files (references/scripts) — open them with skill_read_file and run scripts with run_command.",
    parameters: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] },
    execute: async (input) => {
      const s = await getSkill(input.skill as string);
      if (!s) return `No skill "${input.skill}".`;
      const files = await listSkillFiles(input.skill as string);
      const note = files.length > 0 ? `\n\n---\nBundled files (read with skill_read_file):\n${files.map((f) => `- ${f}`).join("\n")}` : "";
      return `# ${s.name}\n${s.content}${note}`;
    },
  },
  skill_read_file: {
    description:
      "Read a bundled file from a skill by relative path (e.g. 'editing.md', 'scripts/thumbnail.py'). Read-only, scoped to the skill's directory.",
    parameters: {
      type: "object",
      properties: { skill: { type: "string" }, path: { type: "string" } },
      required: ["skill", "path"],
    },
    execute: async (input) => readSkillFile(input.skill as string, input.path as string),
  },
  // Scheduler operations — safe (sandboxed under data/scheduler) so they're part
  // of every sub-agent's base toolkit, letting the assistant help users schedule
  // tasks via natural conversation with no capability config needed.
  ...SCHEDULER_TOOLS,
};

// Repo-scoped developer tools: these operate on the actual BrowserOS source so a
// developer sub-agent can modify BOS itself. Powerful, so they are NOT part of
// the default tool set — an agent must opt in by listing them in its `tools`.
export const DEV_TOOLS: Record<string, LlmTool> = {
  bos_source_list: {
    description: "List files/folders in the BrowserOS source repository (relative to repo root, e.g. 'src/components').",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repo-relative dir, defaults to '.'" } } },
    execute: async (input) => JSON.stringify(await repo.listDir((input.path as string) || ".")),
  },
  bos_source_read: {
    description: "Read a source file from the BrowserOS repository (repo-relative path, e.g. 'src/components/apps/settings/SkillsTab.tsx').",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => repo.readFile(input.path as string),
  },
  bos_source_search: {
    description: "Search BrowserOS source files for a string. Returns matching path:line:text. Optionally restrict to a subdirectory.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, dir: { type: "string", description: "Subdir to search, defaults to 'src'" } },
      required: ["query"],
    },
    execute: async (input) => JSON.stringify(await repo.search(input.query as string, { dir: input.dir as string | undefined })),
  },
  // NOTE: run_command is NOT a static DEV_TOOL — it needs a per-run (session,
  // agent) sandbox key, so the runner injects it per delegated run (see runner.ts).
  // NOTE: git_branch / git_stage were removed. Under the Supervisor the live
  // checkout is the running base; branching/staging it breaks the running version
  // and blocks promote. The Supervisor owns version branches and commits the
  // developer's edits on the isolated preview worktree automatically — sub-agents
  // must NOT run git against the main checkout (specs/005, 017 diagnosis).
  dev_git_status: {
    description: "Show the current git branch and changed files.",
    parameters: { type: "object", properties: {} },
    execute: async () => JSON.stringify(await git.status()),
  },
};

// Spec-scoped tools for Build Studio. Specs live in external stores (018): a
// path is STORE-PREFIXED `<storeId>/<rel>` (list stores with an empty path).
// Writes go to the addressed store — refused for read-only stores; system-store
// writes accumulate on a candidate branch until promoted. Opt-in like DEV_TOOLS.
export const SPEC_TOOLS: Record<string, LlmTool> = {
  spec_list: {
    description: "List entries in the spec stores. An empty/omitted path lists the available stores (e.g. 'bos-system-specs', 'user-specs'); a store-prefixed path like 'user-specs/003-my-feature' lists inside a store.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Store-prefixed dir, e.g. 'user-specs' or 'user-specs/003-x'. Empty = list stores." } } },
    execute: async (input) => JSON.stringify(await specfs.listDir((input.path as string) || "")),
  },
  spec_read: {
    description: "Read a specification artifact by its STORE-PREFIXED path, e.g. 'bos-system-specs/001-build-studio/spec.md'. For spec-kit templates use read_template instead.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => specfs.readFile(input.path as string),
  },
  spec_write: {
    description: "Create or overwrite a specification artifact by STORE-PREFIXED path (e.g. 'user-specs/003-x/spec.md'). New user specs go in the user store; system specs require promote. Build the body from a template via read_template.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    execute: async (input) => `Wrote ${await specfs.writeFile(input.path as string, (input.content as string) ?? "")}`,
  },
  spec_edit: {
    description: "Replace a unique snippet of text in a spec artifact (STORE-PREFIXED path; the search text must occur exactly once).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
    },
    execute: async (input) => `Edited ${await specfs.editFile(input.path as string, input.find as string, (input.replace as string) ?? "")}`,
  },
  spec_search: {
    description: "Search spec content across all stores for a string. Returns matching path:line:text. Optionally restrict to a store-prefixed subdirectory.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, dir: { type: "string", description: "Store-prefixed subdir to search (e.g. 'user-specs'); omit to search all stores." } },
      required: ["query"],
    },
    execute: async (input) => JSON.stringify(await specfs.search(input.query as string, { dir: input.dir as string | undefined })),
  },
  spec_template_read: {
    description: "Read a spec-kit template or command prompt from the engine at .specify/templates (e.g. 'spec-template.md', 'plan-template.md', 'commands/specify.md'). Read-only.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => specfs.readTemplate(input.path as string),
  },
  spec_template_list: {
    description: "List available spec-kit templates/command prompts under .specify/templates (optionally a subdir like 'commands').",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async (input) => JSON.stringify(await specfs.listTemplates((input.path as string) || "")),
  },
};

// Build Studio delegates implementation to the Developer via this tool. The real
// implementation is built per-run in the sub-agent runner (it needs the parent
// event stream + a depth guard), so it is referenced here only by id.
export const DELEGATE_TO_DEVELOPER = "dev_delegate";

// Re-export scheduler tools for direct access (e.g. UI showing the tool set).
// They are already merged into SUBAGENT_TOOLS above, so ALL_TOOLS picks them up.
export { SCHEDULER_TOOLS };

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
