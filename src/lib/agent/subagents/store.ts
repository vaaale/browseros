import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { SubAgent, SubAgentType } from "./types";
import { parseFrontmatter, buildFrontmatter, asString, asList } from "./markdown";

const DIR = path.join(process.cwd(), "data", "agents");

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
    description: "Builds and modifies apps and BOS features. Backed by Claude Code.",
    type: "claude",
    systemPrompt: "You are a development sub-agent backed by Claude Code via the dev harness. Implement the requested app or feature carefully and report what you did.",
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
    await fs.writeFile(path.join(DIR, id, "AGENT.md"), toMarkdown({ id, ...d }), "utf8");
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
  await fs.writeFile(path.join(DIR, id, "AGENT.md"), toMarkdown(agent), "utf8");
  return agent;
}

export async function removeSubAgent(idOrName: string): Promise<void> {
  const agent = await getSubAgent(idOrName);
  if (agent) await fs.rm(path.join(DIR, agent.id), { recursive: true, force: true });
}
