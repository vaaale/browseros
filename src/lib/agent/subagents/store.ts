import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import type { Agent, AgentType } from "./types";
import { parseFrontmatter, buildFrontmatter, asString, asList, asBool } from "./markdown";
import { DEFAULT_PERSONALITY } from "@/lib/agent/config";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

const DIR = path.join(dataDir(), "agents");

// Folder id of the shared "default prompt" template. Not a runnable agent — its
// body is prepended to any agent whose useDefaultPrompt is true. Managed via
// Settings → Agents → Default Agent; filtered out of the normal agent list.
export const DEFAULT_PROMPT_AGENT_ID = "default_agent";
const SEED_DEFAULT_AGENT = path.join(process.cwd(), "seed", "default_agent", "AGENT.md");

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `agent-${Date.now().toString(36)}`;
}

interface SeedAgent {
  name: string;
  description: string;
  type: AgentType;
  systemPrompt: string;
  tools?: string[];
  skills?: string[];
  mcp?: string[];
}

const DEFAULTS: SeedAgent[] = [
  {
    name: "Assistant",
    description: "The default BrowserOS assistant personality (used by the main chat).",
    type: "local",
    systemPrompt: DEFAULT_PERSONALITY,
  },
  {
    name: "Researcher",
    description: "Researches topics by fetching web pages and summarizing findings.",
    type: "local",
    systemPrompt: "You are a focused research sub-agent. Use web_fetch to gather information, then write a concise, well-sourced summary. Cite URLs you used.",
  },
  {
    name: "File Organizer",
    description: "Organizes, renames, and tidies files in the virtual file system.",
    type: "local",
    systemPrompt: "You are a file organization sub-agent. Inspect the VFS with file_list/file_read and tidy it using file_write/file_mkdir. Explain what you changed.",
  },
  {
    name: "Writer",
    description: "Drafts and edits documents in the virtual file system.",
    type: "local",
    systemPrompt: "You are a writing sub-agent. Produce clear, well-structured documents and save them to the VFS with file_write when asked.",
  },
  {
    name: "Developer",
    description: "Modifies BrowserOS's own source and builds apps/features. Backed by Claude Code with repo access.",
    type: "claude",
    tools: [
      "dev_git_status",
      "bos_source_list", "bos_source_read", "bos_source_search",
      "run_command",
      "file_list", "file_read", "file_write",
    ],
    systemPrompt:
      "You are the BrowserOS developer sub-agent. You handle two DISTINCT kinds of task — identify which before acting.\n\n" +
      "A) BUILD A STANDALONE APP (iframe app in a window; task says 'build/create an app'). Do NOT use the source workflow, NEVER install it yourself, and NEVER write data/vfs/Apps or installed-apps.json (deprecated) — the orchestrator installs it. Two shapes: (single static) produce ONE self-contained index.html (inline CSS/JS, no external/CDN/network; same-origin BOS API calls ok) and return ONLY that document. (multi-file project — when asked for a TS/TSX or multi-file app, or told to write into a staging dir) WRITE the project ONLY into the named staging dir: a src/main.tsx (or src/main.ts) entry mounting into #root, plus components/CSS; you MAY import React etc. (provided to the bundler, no npm install); do NOT build/install; report the staging dir path. The orchestrator bundles (esbuild) + installs.\n\n" +
      "B) MODIFY BROWSEROS'S OWN SOURCE (built-in apps, pages, settings, server logic under src/). Use the workflow below.\n\n" +
      "BOS is a Next.js (App Router) app: built-in apps live under src/apps/<id>/ (manifest.ts + index.tsx, auto-discovered), shared/app UI under src/components (settings tabs under src/components/apps/settings), server logic and stores under src/lib, OS primitives under src/os, and API routes under src/app/api.\n\n" +
      "Workflow (path B — source edits only) — follow it every time:\n" +
      "1. You are ALREADY in an isolated preview worktree on a dedicated branch that the Supervisor provisioned for this change. Do NOT create or switch git branches, do NOT run any git command, and do NOT edit any directory other than your current working directory — the Supervisor commits, builds, and previews your changes for you. Branching or editing the main checkout would break the running version.\n" +
      "2. Explore with bos_source_list / bos_source_search / bos_source_read to find the exact files to change.\n" +
      "3. Make focused edits with your native file tools (the Claude/OpenCode harness edits files directly). Edits under src/ hot-reload in dev. Change only what the task needs.\n" +
      "4. Verify with run_command 'typecheck' (and 'lint'); fix any errors you introduced.\n" +
      "5. Report exactly what you changed and how to test it.\n\n" +
      "Never edit secrets, package.json, lockfiles, or build config. If you are running via Claude Code / OpenCode (not the local tools above), use your native file and shell tools ONLY to read and edit files inside your current working directory — never run git, never switch branches, and never touch any other checkout.",
  },
  {
    name: "Planner",
    description: "Breaks a task into a concrete plan of sub-tasks with acceptance criteria.",
    type: "local",
    systemPrompt:
      "You are a planning sub-agent. Given a task, produce a concise plan as a numbered list of sub-tasks. For EACH sub-task include: **Name**, **Description**, and **Acceptance criteria**. Keep it actionable and ordered by dependency. Do not implement anything — only plan.",
  },
  {
    name: "Build Studio",
    description:
      "Authors and refines BOS specifications using spec-kit, and delegates implementation to the Developer sub-agent.",
    type: "local",
    // Unified allowlist (016): server tools (delegated runs) + client actions
    // (as the active personality). Both contexts filter this one list to their own ids.
    tools: [
      "spec_list", "spec_read", "spec_write", "spec_edit", "spec_search", "spec_template_read", "spec_template_list",
      "dev_delegate", "buildstudio_artifact_open", "buildstudio_tree_refresh", "buildstudio_run_tests",
      "dev_branch_request",
      "web_view", "file_list", "file_read", "file_write",
      "agent_delegate", "skill_list", "skill_load", "skill_read_file", "memory_save", "memory_recall", "docs_list", "docs_read",
    ],
    skills: ["build-studio", "feature-wizard"],
    mcp: [],
    systemPrompt:
      "You are Build Studio, the BrowserOS spec-authoring agent. You operate the Software-As-A-Prompt workflow: every feature is defined by a specification under specs/ before it is built.\n\n" +
      'You work through your skills. Load and follow the "Build Studio" skill for spec-kit pipeline steps (constitution, specify, clarify, plan, tasks, analyze, implement, converge), and the "Feature Wizard" skill when guiding a user through building a new feature end-to-end.\n\n' +
      "Hard rules:\n" +
      "- Read and write ONLY specification artifacts via your spec tools. Specs live in external stores: paths are STORE-PREFIXED `<storeId>/<rel>` (call spec_list with no path to see the stores, e.g. 'bos-system-specs', 'user-specs'). New specs you author go in the user store; edits commit-on-save to the store's checked-out branch (inside a feature preview: the feature branch, promoted/discarded with the code). You CANNOT and MUST NOT modify BOS source.\n" +
      "- Build artifact bodies from the spec-kit templates via spec_template_read / spec_template_list (the engine at .specify/templates).\n" +
      "- For the `implement` step, call dev_delegate with the feature's spec/plan/tasks context and acceptance criteria — never write code yourself.\n" +
      "- Keep specs and docs in sync; record spec/code drift in the system store's discrepancies.md.\n" +
      "- The constitution (in the system store at .specify/memory/constitution.md) is special: if a request would require changing it, do NOT blindly comply — confirm it is the right call and explore alternatives with the user first.\n" +
      "- After the Developer builds a feature, run analyze + converge; if discrepancies are found, ask the user for confirmation before instructing the Developer to fix them.\n" +
      "- file_write / file_read / file_list operate on the USER'S VFS (for HTML mockups etc.) — never on BOS source.",
  },
];

function toMarkdown(a: Agent): string {
  return buildFrontmatter(
    {
      name: a.name,
      description: a.description,
      type: a.type,
      model: a.model,
      subagent_type: a.subagentType,
      tools: a.tools,
      skills: a.skills,
      mcp: a.mcp,
      useDefaultPrompt: a.useDefaultPrompt,
    },
    a.systemPrompt,
  );
}

function fromMarkdown(id: string, src: string): Agent {
  const { meta, body } = parseFrontmatter(src);
  const type = (asString(meta.type) === "claude" ? "claude" : "local") as AgentType;
  return {
    id,
    name: asString(meta.name) || id,
    description: asString(meta.description) || "",
    type,
    systemPrompt: body,
    tools: asList(meta.tools),
    skills: asList(meta.skills),
    mcp: asList(meta.mcp),
    useDefaultPrompt: asBool(meta.useDefaultPrompt),
    model: asString(meta.model),
    subagentType: asString(meta.subagent_type),
  };
}

async function writeSeedAgent(d: SeedAgent): Promise<void> {
  const id = slugify(d.name);
  await fs.mkdir(path.join(DIR, id), { recursive: true });
  await writeFileAtomic(path.join(DIR, id, "AGENT.md"), toMarkdown({ id, ...d }));
}

// Agents that must exist on EVERY install, including ones upgraded from before
// the agent shipped. They are back-filled only when missing, never overwriting
// a user's edits to an existing agent of the same id.
const ADDITIVE_DEFAULTS = DEFAULTS.filter((d) => d.name === "Build Studio");

let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  const existing = await fs.readdir(DIR).catch(() => [] as string[]);
  if (existing.length === 0) {
    for (const d of DEFAULTS) await writeSeedAgent(d);
  } else {
    for (const d of ADDITIVE_DEFAULTS) {
      if (!existing.includes(slugify(d.name))) await writeSeedAgent(d);
    }
    // Back-fill Build Studio's unified capability ids on upgraded installs (016):
    // its allowlist must contain action ids or per-agent action gating can't apply
    // (the back-compat rule otherwise leaves an action-id-less allowlist fully open).
    // Union only — never removes a user's customizations.
    await reconcileBuildStudioTools();
  }
  await ensureDefaultPromptAgent();
}

// Copies seed/default_agent/AGENT.md into data/agents/default_agent on first
// run so the shared prompt is user-editable. Never overwrites an existing file.
async function ensureDefaultPromptAgent(): Promise<void> {
  const dst = path.join(DIR, DEFAULT_PROMPT_AGENT_ID, "AGENT.md");
  try {
    await fs.access(dst);
    return;
  } catch { /* file missing — seed */ }
  try {
    const src = await fs.readFile(SEED_DEFAULT_AGENT, "utf8");
    await fs.mkdir(path.join(DIR, DEFAULT_PROMPT_AGENT_ID), { recursive: true });
    await writeFileAtomic(dst, src);
  } catch {
    // Seed bundle missing (unexpected) — leave dst absent; composeInstructions
    // falls back to its baked-in defaults so nothing crashes.
  }
}

async function reconcileBuildStudioTools(): Promise<void> {
  const seed = DEFAULTS.find((d) => d.name === "Build Studio");
  if (!seed) return;
  const id = slugify(seed.name);
  const file = path.join(DIR, id, "AGENT.md");
  let src: string;
  try {
    src = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  const agent = fromMarkdown(id, src);
  const have = new Set(agent.tools ?? []);
  const missing = (seed.tools ?? []).filter((t) => !have.has(t));
  if (missing.length === 0) return;
  await writeFileAtomic(file, toMarkdown({ ...agent, tools: [...(agent.tools ?? []), ...missing] }));
}

export async function listSubAgents(): Promise<Agent[]> {
  await ensureSeed();
  const dirs = await fs.readdir(DIR, { withFileTypes: true }).catch(() => []);
  const agents: Agent[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (d.name === DEFAULT_PROMPT_AGENT_ID) continue;
    try {
      const src = await fs.readFile(path.join(DIR, d.name, "AGENT.md"), "utf8");
      agents.push(fromMarkdown(d.name, src));
    } catch {
      /* skip dirs without AGENT.md */
    }
  }
  return agents;
}

/** The shared default-prompt template (its body is prepended to agents whose
 *  useDefaultPrompt is true). Read and edited only via Settings → Agents →
 *  Default Agent — NOT surfaced by listSubAgents. */
export async function getDefaultPromptAgent(): Promise<Agent | undefined> {
  await ensureSeed();
  try {
    const src = await fs.readFile(path.join(DIR, DEFAULT_PROMPT_AGENT_ID, "AGENT.md"), "utf8");
    return fromMarkdown(DEFAULT_PROMPT_AGENT_ID, src);
  } catch {
    return undefined;
  }
}

/** Rewrite the shared default-prompt template's body (and optionally its meta).
 *  Kept minimal: the template is a body-first document — description is the only
 *  frontmatter a user might reasonably want to edit. */
export async function setDefaultPromptAgent(input: { systemPrompt: string; description?: string }): Promise<Agent> {
  await ensureSeed();
  const existing = await getDefaultPromptAgent();
  const updated: Agent = {
    id: DEFAULT_PROMPT_AGENT_ID,
    name: existing?.name || "Default",
    description: input.description ?? existing?.description ?? "Shared default prompt.",
    type: "local",
    systemPrompt: input.systemPrompt,
  };
  await fs.mkdir(path.join(DIR, DEFAULT_PROMPT_AGENT_ID), { recursive: true });
  await writeFileAtomic(path.join(DIR, DEFAULT_PROMPT_AGENT_ID, "AGENT.md"), toMarkdown(updated));
  return updated;
}

export async function getAgent(idOrName: string): Promise<Agent | undefined> {
  const key = idOrName.toLowerCase();
  return (await listSubAgents()).find((a) => a.id.toLowerCase() === key || a.name.toLowerCase() === key);
}

export async function createSubAgent(input: {
  name: string;
  description: string;
  type?: AgentType;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  subagentType?: string;
}): Promise<Agent> {
  await ensureSeed();
  const id = slugify(input.name);
  const agent: Agent = { id, type: input.type ?? "local", ...input };
  await fs.mkdir(path.join(DIR, id), { recursive: true });
  await writeFileAtomic(path.join(DIR, id, "AGENT.md"), toMarkdown(agent));
  return agent;
}

export async function removeSubAgent(idOrName: string): Promise<void> {
  const agent = await getAgent(idOrName);
  if (agent) await fs.rm(path.join(DIR, agent.id), { recursive: true, force: true });
}

// NOTE: there is deliberately no global "active agent". Each conversation carries
// its own agent id (per-conversation), which is the ONLY source of truth. Agent
// resolution for a request requires that explicit id (see composeInstructions) —
// there is no mutable global to fall back to.

/** Replace an agent's system prompt (its instructions/personality), preserving its metadata. */
export async function setAgentSystemPrompt(id: string, systemPrompt: string): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = { ...agent, systemPrompt };
  await writeFileAtomic(path.join(DIR, agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** Update an agent's capability allowlists (tools/skills/mcp). Only provided
 *  classes are changed; unset/empty means "all" at enforcement time. */
export async function setAgentCapabilities(
  id: string,
  caps: { tools?: string[]; skills?: string[]; mcp?: string[] },
): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = {
    ...agent,
    tools: caps.tools ?? agent.tools,
    skills: caps.skills ?? agent.skills,
    mcp: caps.mcp ?? agent.mcp,
  };
  await writeFileAtomic(path.join(DIR, agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** Update an agent's name and/or description without touching its system prompt
 *  or capability allowlists. Fields left undefined are preserved as-is. */
export async function setAgentMeta(
  id: string,
  meta: { name?: string; description?: string },
): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = {
    ...agent,
    name: typeof meta.name === "string" ? meta.name : agent.name,
    description: typeof meta.description === "string" ? meta.description : agent.description,
  };
  await writeFileAtomic(path.join(DIR, agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** The default assistant agent cannot be deleted — the main chat's personality
 *  slot points at it. Callers should surface this to the user rather than trap
 *  the error. */
export class ProtectedAgentError extends Error {
  constructor(id: string) {
    super(`Agent "${id}" is protected and cannot be deleted.`);
    this.name = "ProtectedAgentError";
  }
}

export function isProtectedAgentId(id: string): boolean {
  return id === DEFAULT_AGENT_ID;
}

/** Delete a sub-agent by id, rejecting the default assistant. Resolves the
 *  id/name the same way removeSubAgent does. */
export async function deleteSubAgent(idOrName: string): Promise<void> {
  const agent = await getAgent(idOrName);
  if (!agent) return;
  if (isProtectedAgentId(agent.id)) throw new ProtectedAgentError(agent.id);
  await fs.rm(path.join(DIR, agent.id), { recursive: true, force: true });
}
