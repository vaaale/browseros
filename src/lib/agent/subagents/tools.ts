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
import { readMetadataOverrides } from "@/lib/agent/tool-metadata-overrides";
import { CAPABILITIES, groupDescription } from "@/lib/agent/capabilities-registry";
import { scoreCapability, scoreAgent } from "@/lib/agent/discovery-score";
import { listSubAgents } from "./store";

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
    execute: async (input) => {
      try {
        return formatWebSearchForModel(await webSearch({
          query: input.query as string,
          allowed_domains: input.allowed_domains as string[] | undefined,
          blocked_domains: input.blocked_domains as string[] | undefined,
        }));
      } catch (e) {
        return `web_search unavailable: ${(e as Error).message}`;
      }
    },
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
// Writes go to the addressed store — refused for read-only stores. When a feature
// branch is active (bound per-run via makeSpecTools), ALL ops target that branch's
// worktree spec store (020) so specs land on the same branch the Developer builds;
// otherwise the base checkout. Opt-in like DEV_TOOLS.
export function makeSpecTools(branch?: string): Record<string, LlmTool> {
  const ctx = branch ? { branch } : undefined;
  return {
    spec_list: {
      description: "List entries in the spec stores. An empty/omitted path lists the available stores (e.g. 'bos-system-specs', 'user-specs'); a store-prefixed path like 'user-specs/003-my-feature' lists inside a store.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Store-prefixed dir, e.g. 'user-specs' or 'user-specs/003-x'. Empty = list stores." } } },
      execute: async (input) => JSON.stringify(await specfs.listDir((input.path as string) || "", ctx)),
    },
    spec_read: {
      description: "Read a specification artifact by its STORE-PREFIXED path, e.g. 'bos-system-specs/001-build-studio/spec.md'. For spec-kit templates use read_template instead.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (input) => specfs.readFile(input.path as string, ctx),
    },
    spec_write: {
      description: "Create or overwrite a specification artifact by STORE-PREFIXED path (e.g. 'user-specs/003-x/spec.md'). New user specs go in the user store; writes go to the conversation's active feature branch when one is set. Build the body from a template via read_template.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      execute: async (input) => `Wrote ${await specfs.writeFile(input.path as string, (input.content as string) ?? "", ctx)}`,
    },
    spec_edit: {
      description: "Replace a unique snippet of text in a spec artifact (STORE-PREFIXED path; the search text must occur exactly once).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
        required: ["path", "find", "replace"],
      },
      execute: async (input) => `Edited ${await specfs.editFile(input.path as string, input.find as string, (input.replace as string) ?? "", ctx)}`,
    },
    spec_search: {
      description: "Search spec content across all stores for a string. Returns matching path:line:text. Optionally restrict to a store-prefixed subdirectory.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, dir: { type: "string", description: "Store-prefixed subdir to search (e.g. 'user-specs'); omit to search all stores." } },
        required: ["query"],
      },
      execute: async (input) => JSON.stringify(await specfs.search(input.query as string, { dir: input.dir as string | undefined, branch })),
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
}

// Static, unbound instance — used for tool-id enumeration and as the base (base
// checkout) tool set. Per-run branch binding happens in runLocal via makeSpecTools.
export const SPEC_TOOLS: Record<string, LlmTool> = makeSpecTools();

// Build Studio delegates implementation to the Developer via this tool. The real
// implementation is built per-run in the sub-agent runner (it needs the parent
// event stream + a depth guard), so it is referenced here only by id.
export const DELEGATE_TO_DEVELOPER = "dev_delegate";

// Static parameter schemas for the two per-run-built tools. Exposed here so
// discovery (025) can return their JSON schema without the runner needing to
// have instantiated the concrete tool yet. The runner's per-run factories
// re-use these constants to keep the schema in one place.
export const DEV_DELEGATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task: { type: "string", description: "Full implementation task with context and acceptance criteria." },
  },
  required: ["task"],
};

export const RUN_COMMAND_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    command: { type: "string" },
    language: { type: "string", enum: ["bash", "python", "node"] },
    skill: { type: "string", description: "Optional skill id to stage into the working dir first." },
    timeoutMs: { type: "number" },
  },
  required: ["command"],
};

// Re-export scheduler tools for direct access (e.g. UI showing the tool set).
// They are already merged into SUBAGENT_TOOLS above, so ALL_TOOLS picks them up.
export { SCHEDULER_TOOLS };

const ALL_TOOLS: Record<string, LlmTool> = { ...SUBAGENT_TOOLS, ...DEV_TOOLS, ...SPEC_TOOLS };

/**
 * Resolve the tools a sub-agent may use (Phase B strict allowlist). Contract:
 *   - allowed == null/undefined → return {} (zero tools; the on-disk migration
 *     in subagents/store.ts backfills legacy agents with the full capability
 *     set so an existing agent never lands here on upgrade).
 *   - allowed.length === 0 → return {} (an agent configured with no tools
 *     has no tools; no more "empty means all" surprise).
 *   - allowed with entries → filter ALL_TOOLS to the listed ids.
 *
 * Tool descriptions are overlaid from data/tool-metadata-overrides.json
 * (Settings → Tools) so a user can rewrite the LLM-facing description without
 * editing source. Per-agent deferred visibility is not read here — the runner
 * reads the agent's own `deferredTools` list to decide what to hide (there is
 * no registry-wide default).
 */
export async function toolsFor(allowed?: string[]): Promise<Record<string, LlmTool>> {
  const overrides = await readMetadataOverrides();
  if (!allowed || allowed.length === 0) return {};
  const base = Object.fromEntries(
    allowed.filter((id) => ALL_TOOLS[id]).map((id) => [id, ALL_TOOLS[id]]),
  );
  return applyDescriptionOverrides(base, overrides);
}

function applyDescriptionOverrides(
  tools: Record<string, LlmTool>,
  overrides: Record<string, { description?: string }>,
): Record<string, LlmTool> {
  const out: Record<string, LlmTool> = {};
  for (const [id, tool] of Object.entries(tools)) {
    const desc = overrides[id]?.description;
    out[id] = desc ? { ...tool, description: desc } : tool;
  }
  return out;
}

// Static parameter-schema map for every discoverable sub-agent tool. Includes
// SUBAGENT_TOOLS + DEV_TOOLS + SPEC_TOOLS AND the static schemas for the
// per-run-built tools (dev_delegate, run_command) so 025 discovery works even
// before the runner has instantiated them for this run.
const STATIC_SCHEMAS: Record<string, Record<string, unknown>> = {
  ...Object.fromEntries(Object.entries(ALL_TOOLS).map(([id, t]) => [id, t.parameters])),
  [DELEGATE_TO_DEVELOPER]: DEV_DELEGATE_SCHEMA,
  run_command: RUN_COMMAND_SCHEMA,
};

/** JSON parameter schema for a sub-agent tool id, or undefined if unknown. */
export function getToolSchema(id: string): Record<string, unknown> | undefined {
  return STATIC_SCHEMAS[id];
}

interface FindToolsResult {
  id: string;
  group: string;
  description: string;
  schema: Record<string, unknown>;
  score: number;
}

interface FindAgentResult {
  id: string;
  name: string;
  type: string;
  description: string;
  score: number;
}

/**
 * Build the two runtime-discovery tools (025-deferred-tool-discovery).
 *
 * - `find_tools(query)` scores every deferred capability the agent is allowed
 *   to use, returns the top `maxResults` with full JSON schema, and calls
 *   `reveal(ids)` so the returned tools become visible in the next step of the
 *   surrounding tool loop.
 * - `find_agent(query)` scores agents by identity metadata only — never
 *   exposing the target's tool composition (spec clarification 1).
 */
export function makeDiscoveryTools(args: {
  /** The calling agent's strict allowlist. Empty ⇒ no registry tools. */
  allow: string[];
  /** The runner's live tool map. Only ids present here are discoverable. */
  tools: Record<string, LlmTool>;
  /** The effective deferred set for THIS agent: its own `deferredTools` (no
   *  registry-wide default). A tool is discoverable iff it appears in this
   *  set. */
  effectiveDeferred: Set<string>;
  /** Register discovered ids as revealed so the loop exposes them next step. */
  reveal: (ids: string[]) => void;
  /** Cap on results, resolved from Settings → Tools (5..25, default 10). */
  maxResults: number;
}): Record<string, LlmTool> {
  const { allow, tools, effectiveDeferred, reveal, maxResults } = args;
  const allowSet = new Set(allow);

  return {
    find_tools: {
      description:
        "Discover deferred capabilities by natural-language query. Returns top-scoring deferred tools (id, group, description, JSON schema) that YOU are allowed to use; once returned, each becomes callable in the next step of this loop. Use this whenever a needed tool is not in your visible tools list.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language description of the capability you need (min 2 chars)." },
        },
        required: ["query"],
      },
      execute: async (input) => {
        const query = String(input.query ?? "").trim();
        if (query.length < 2) return JSON.stringify([]);

        // Score every capability that is deferred FOR THIS AGENT and that the
        // agent could actually call under its strict allowlist.
        const candidates = CAPABILITIES
          .filter((c) => effectiveDeferred.has(c.id))
          .filter((c) => allowSet.has(c.id))
          .filter((c) => tools[c.id] !== undefined || getToolSchema(c.id) !== undefined);

        const scored = candidates
          .map((c) => ({ cap: c, score: scoreCapability(c, query, groupDescription(c.group)) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);

        const results: FindToolsResult[] = scored.map(({ cap, score }) => {
          const live = tools[cap.id];
          const schema = live?.parameters ?? getToolSchema(cap.id) ?? { type: "object", properties: {} };
          return {
            id: cap.id,
            group: cap.group,
            description: live?.description ?? cap.description,
            schema,
            score,
          };
        });

        // Promote the discovered tools into the loop's visible set. Only tools
        // the runner actually has can be revealed — schema-only entries (rare)
        // are informational for the model.
        const revealable = results.map((r) => r.id).filter((id) => tools[id] !== undefined);
        if (revealable.length) reveal(revealable);
        return JSON.stringify(results);
      },
    },
    find_agent: {
      description:
        "Discover sub-agents you can delegate to by natural-language query. Returns each candidate agent's identity metadata (id, name, type, description) — never their internal tools list. Use before agent_delegate/dev_delegate when you don't already know which agent should handle a task.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language description of the task or specialization you need (min 2 chars)." },
        },
        required: ["query"],
      },
      execute: async (input) => {
        const query = String(input.query ?? "").trim();
        if (query.length < 2) return JSON.stringify([]);
        const agents = await listSubAgents();
        const scored = agents
          .map((a) => ({
            agent: a,
            score: scoreAgent({ name: a.name, description: a.description, type: a.type }, query),
          }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);

        const results: FindAgentResult[] = scored.map(({ agent, score }) => ({
          id: agent.id,
          name: agent.name,
          type: agent.type,
          description: agent.description,
          score,
        }));
        return JSON.stringify(results);
      },
    },
  };
}

// Convenience: which of the runner's tool ids are deferred under the given
// effective-deferred set. Used by runner.ts to build the initial `hiddenIds`
// set for the tool loop.
export function pickDeferredIds(
  tools: Record<string, LlmTool>,
  effectiveDeferred: Set<string>,
): Set<string> {
  return new Set(Object.keys(tools).filter((id) => effectiveDeferred.has(id)));
}
