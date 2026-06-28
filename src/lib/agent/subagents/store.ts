import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import type { SubAgent, SubAgentType } from "./types";
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
  type: SubAgentType;
  systemPrompt: string;
  tools?: string[];
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
      "git_branch", "git_status", "git_stage",
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
      "1. Create a feature branch first (git_branch) so changes are reversible.\n" +
      "2. Explore with list_source / search_source / read_source to find the exact files to change.\n" +
      "3. Make focused edits with edit_source / write_source. Edits under src/ hot-reload in dev. Change only what the task needs.\n" +
      "4. Verify with run_command 'typecheck' (and 'lint'); fix any errors you introduced.\n" +
      "5. Stage your changes with git_stage and report exactly what you changed and how to test it.\n\n" +
      "Never edit secrets, package.json, lockfiles, or build config. If you are running via Claude Code (not the local tools above), use your native file and shell tools to perform the same branch → explore → edit → typecheck → stage workflow in this repository.",
  },
  {
    name: "Planner",
    description: "Breaks a task into a concrete plan of sub-tasks with acceptance criteria.",
    type: "local",
    systemPrompt:
      "You are a planning sub-agent. Given a task, produce a concise plan as a numbered list of sub-tasks. For EACH sub-task include: **Name**, **Description**, and **Acceptance criteria**. Keep it actionable and ordered by dependency. Do not implement anything — only plan.",
  },
];

function toMarkdown(a: SubAgent): string {
  return buildFrontmatter(
    { name: a.name, description: a.description, type: a.type, model: a.model, subagent_type: a.subagentType, tools: a.tools },
    a.systemPrompt,
  );
}

function fromMarkdown(id: string, src: string): SubAgent {
  const { meta, body } = parseFrontmatter(src);
  const type = (asString(meta.type) === "claude" ? "claude" : "local") as SubAgentType;
  return {
    id,
    name: asString(meta.name) || id,
    description: asString(meta.description) || "",
    type,
    systemPrompt: body,
    tools: asList(meta.tools),
    model: asString(meta.model),
    subagentType: asString(meta.subagent_type),
  };
}

let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  const existing = await fs.readdir(DIR).catch(() => []);
  if (existing.length > 0) return;
  for (const d of DEFAULTS) {
    const id = slugify(d.name);
    await fs.mkdir(path.join(DIR, id), { recursive: true });
    await writeFileAtomic(path.join(DIR, id, "AGENT.md"), toMarkdown({ id, ...d }));
  }
}

export async function listSubAgents(): Promise<SubAgent[]> {
  await ensureSeed();
  const dirs = await fs.readdir(DIR, { withFileTypes: true }).catch(() => []);
  const agents: SubAgent[] = [];
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

export async function getSubAgent(idOrName: string): Promise<SubAgent | undefined> {
  const key = idOrName.toLowerCase();
  return (await listSubAgents()).find((a) => a.id.toLowerCase() === key || a.name.toLowerCase() === key);
}

export async function createSubAgent(input: {
  name: string;
  description: string;
  type?: SubAgentType;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  subagentType?: string;
}): Promise<SubAgent> {
  await ensureSeed();
  const id = slugify(input.name);
  const agent: SubAgent = { id, type: input.type ?? "local", ...input };
  await fs.mkdir(path.join(DIR, id), { recursive: true });
  await writeFileAtomic(path.join(DIR, id, "AGENT.md"), toMarkdown(agent));
  return agent;
}

export async function removeSubAgent(idOrName: string): Promise<void> {
  const agent = await getSubAgent(idOrName);
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
  const agent = await getSubAgent(await getActiveAgentId());
  return agent?.systemPrompt?.trim() || DEFAULT_PERSONALITY;
}

/** Replace an agent's system prompt (its instructions/personality), preserving its metadata. */
export async function setAgentSystemPrompt(id: string, systemPrompt: string): Promise<SubAgent | undefined> {
  const agent = await getSubAgent(id);
  if (!agent) return undefined;
  const updated: SubAgent = { ...agent, systemPrompt };
  await writeFileAtomic(path.join(DIR, agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}
