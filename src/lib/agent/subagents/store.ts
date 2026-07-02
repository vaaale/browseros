import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import type { Agent, AgentType } from "./types";
import { parseFrontmatter, buildFrontmatter, asString, asList } from "./markdown";
import { readNamespace, patchNamespace } from "@/lib/config/store";
import { DEFAULT_PERSONALITY } from "@/lib/agent/config";

const DIR = path.join(dataDir(), "agents");
// The agent whose system prompt is the main assistant's active personality.
const DEFAULT_AGENT_ID = "assistant";

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
    systemPrompt: "You are a file organization sub-agent. Inspect the VFS with list_files/read_file and tidy it using write_file/create_folder. Explain what you changed.",
  },
  {
    name: "Writer",
    description: "Drafts and edits documents in the virtual file system.",
    type: "local",
    systemPrompt: "You are a writing sub-agent. Produce clear, well-structured documents and save them to the VFS with write_file when asked.",
  },
  {
    name: "Developer",
    description: "Modifies BrowserOS's own source and builds apps/features. Backed by Claude Code with repo access.",
    type: "claude",
    tools: [
      "git_status",
      "list_source", "read_source", "search_source", "write_source", "edit_source",
      "run_command",
      "list_files", "read_file", "write_file",
    ],
    systemPrompt:
      "You are the BrowserOS developer sub-agent. You handle two DISTINCT kinds of task — identify which before acting.\n\n" +
      "A) BUILD A STANDALONE APP (iframe app in a window; task says 'build/create an app'). Do NOT use the source workflow, NEVER install it yourself, and NEVER write data/vfs/Apps or installed-apps.json (deprecated) — the orchestrator installs it. Two shapes: (single static) produce ONE self-contained index.html (inline CSS/JS, no external/CDN/network; same-origin BOS API calls ok) and return ONLY that document. (multi-file project — when asked for a TS/TSX or multi-file app, or told to write into a staging dir) WRITE the project ONLY into the named staging dir: a src/main.tsx (or src/main.ts) entry mounting into #root, plus components/CSS; you MAY import React etc. (provided to the bundler, no npm install); do NOT build/install; report the staging dir path. The orchestrator bundles (esbuild) + installs.\n\n" +
      "B) MODIFY BROWSEROS'S OWN SOURCE (built-in apps, pages, settings, server logic under src/). Use the workflow below.\n\n" +
      "BOS is a Next.js (App Router) app: built-in apps live under src/apps/<id>/ (manifest.ts + index.tsx, auto-discovered), shared/app UI under src/components (settings tabs under src/components/apps/settings), server logic and stores under src/lib, OS primitives under src/os, and API routes under src/app/api.\n\n" +
      "Workflow (path B — source edits only) — follow it every time:\n" +
      "1. You are ALREADY in an isolated preview worktree on a dedicated branch that the Supervisor provisioned for this change. Do NOT create or switch git branches, do NOT run any git command, and do NOT edit any directory other than your current working directory — the Supervisor commits, builds, and previews your changes for you. Branching or editing the main checkout would break the running version.\n" +
      "2. Explore with list_source / search_source / read_source to find the exact files to change.\n" +
      "3. Make focused edits with edit_source / write_source. Edits under src/ hot-reload in dev. Change only what the task needs.\n" +
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
      // server sub-agent tools (toolsFor, delegated)
      "list_specs", "read_spec", "write_spec", "edit_spec", "search_specs", "read_template", "list_templates", "delegate_to_developer",
      // main-chat actions (gated when active personality)
      "listSpecs", "readSpec", "writeSpec", "editSpec", "searchSpecs",
      "openSpecArtifact", "refreshSpecTree",
      "delegateToSubAgent", "loadSkill", "memory", "recallMemories", "listDocs", "readDoc",
    ],
    skills: ["build-studio"],
    mcp: [],
    systemPrompt:
      "You are Build Studio, the BrowserOS spec-authoring agent. You operate the Software-As-A-Prompt workflow: every feature is defined by a specification under specs/ before it is built.\n\n" +
      'You work through your skills. Load and follow the "Build Studio" skill, which holds the spec-kit pipeline (constitution, specify, clarify, plan, tasks, analyze, implement, converge) and its per-command references.\n\n' +
      "Hard rules:\n" +
      "- Read and write ONLY specification artifacts via your spec tools. Specs live in external stores: paths are STORE-PREFIXED `<storeId>/<rel>` (call list_specs with no path to see the stores, e.g. 'bos-system-specs', 'user-specs'). New specs you author go in the user store; system-store edits accumulate on a candidate branch until promoted. You CANNOT and MUST NOT modify BOS source.\n" +
      "- Build artifact bodies from the spec-kit templates via read_template / list_templates (the engine at .specify/templates).\n" +
      "- For the `implement` step, call delegate_to_developer with the feature's spec/plan/tasks context and acceptance criteria — never write code yourself.\n" +
      "- Keep specs and docs in sync; record spec/code drift in the system store's discrepancies.md.\n" +
      "- The constitution (in the system store at .specify/memory/constitution.md) is special: if a request would require changing it, do NOT blindly comply — confirm it is the right call and explore alternatives with the user first.\n" +
      "- After the Developer builds a feature, run analyze + converge; if discrepancies are found, ask the user for confirmation before instructing the Developer to fix them.",
  },
];

function toMarkdown(a: Agent): string {
  return buildFrontmatter(
    { name: a.name, description: a.description, type: a.type, model: a.model, subagent_type: a.subagentType, tools: a.tools, skills: a.skills, mcp: a.mcp },
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
    return;
  }
  for (const d of ADDITIVE_DEFAULTS) {
    if (!existing.includes(slugify(d.name))) await writeSeedAgent(d);
  }
  // Back-fill Build Studio's unified capability ids on upgraded installs (016):
  // its allowlist must contain action ids or per-agent action gating can't apply
  // (the back-compat rule otherwise leaves an action-id-less allowlist fully open).
  // Union only — never removes a user's customizations.
  await reconcileBuildStudioTools();
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
    try {
      const src = await fs.readFile(path.join(DIR, d.name, "AGENT.md"), "utf8");
      agents.push(fromMarkdown(d.name, src));
    } catch {
      /* skip dirs without AGENT.md */
    }
  }
  return agents;
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

// --- The active assistant agent (the main chat's personality) ---
// The main assistant adopts one agent's system prompt as its personality. It is
// stored as an id in the "assistant" config namespace; the agents themselves
// live alongside the delegatable sub-agents (there is no separate "profile").

export async function getActiveAgentId(): Promise<string> {
  const cfg = await readNamespace("assistant");
  return (cfg.activeAgent as string) || DEFAULT_AGENT_ID;
}

export async function setActiveAgentId(id: string): Promise<void> {
  await patchNamespace("assistant", { activeAgent: id });
}

/** The active agent's system prompt — used to compose the assistant's instructions. */
export async function getActiveAgentBody(): Promise<string> {
  await ensureSeed();
  const agent = await getAgent(await getActiveAgentId());
  return agent?.systemPrompt?.trim() || DEFAULT_PERSONALITY;
}

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
