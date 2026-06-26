import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { SubAgent } from "./types";

const FILE = path.join(process.cwd(), "data", "subagents.json");

const DEFAULTS: SubAgent[] = [
  {
    id: "researcher",
    name: "Researcher",
    description: "Researches topics by fetching web pages and summarizing findings.",
    systemPrompt:
      "You are a focused research sub-agent. Use web_fetch to gather information, then write a concise, well-sourced summary. Cite URLs you used.",
  },
  {
    id: "organizer",
    name: "File Organizer",
    description: "Organizes, renames, and tidies files in the virtual file system.",
    systemPrompt:
      "You are a file organization sub-agent. Inspect the VFS with list_files/read_file and tidy it using write_file/create_folder. Be careful and explain what you changed.",
  },
  {
    id: "writer",
    name: "Writer",
    description: "Drafts and edits documents in the virtual file system.",
    systemPrompt:
      "You are a writing sub-agent. Produce clear, well-structured documents and save them to the VFS with write_file when asked.",
  },
];

export async function listSubAgents(): Promise<SubAgent[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as SubAgent[];
  } catch {
    return DEFAULTS;
  }
}

async function save(agents: SubAgent[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(agents, null, 2), "utf8");
}

export async function getSubAgent(idOrName: string): Promise<SubAgent | undefined> {
  const agents = await listSubAgents();
  const key = idOrName.toLowerCase();
  return agents.find((a) => a.id.toLowerCase() === key || a.name.toLowerCase() === key);
}

export async function createSubAgent(input: {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
}): Promise<SubAgent> {
  const agents = await listSubAgents();
  const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `agent-${Date.now()}`;
  const agent: SubAgent = { id, ...input };
  await save([...agents.filter((a) => a.id !== id), agent]);
  return agent;
}

export async function removeSubAgent(idOrName: string): Promise<SubAgent[]> {
  const key = idOrName.toLowerCase();
  const next = (await listSubAgents()).filter((a) => a.id.toLowerCase() !== key && a.name.toLowerCase() !== key);
  await save(next);
  return next;
}
