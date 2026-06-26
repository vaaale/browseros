import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { AGENT_SYSTEM_PROMPT } from "./config";

const FILE = path.join(process.cwd(), "data", "agent-profile.json");

export interface AgentSkill {
  name: string;
  content: string;
}

export interface AgentProfile {
  instructions: string;
  skills: AgentSkill[];
}

const DEFAULT_PROFILE: AgentProfile = { instructions: AGENT_SYSTEM_PROMPT, skills: [] };

export async function getProfile(): Promise<AgentProfile> {
  try {
    return { ...DEFAULT_PROFILE, ...(JSON.parse(await fs.readFile(FILE, "utf8")) as Partial<AgentProfile>) };
  } catch {
    return DEFAULT_PROFILE;
  }
}

async function save(profile: AgentProfile): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(profile, null, 2), "utf8");
}

export async function updateInstructions(instructions: string): Promise<AgentProfile> {
  const profile = await getProfile();
  profile.instructions = instructions;
  await save(profile);
  return profile;
}

export async function addSkill(skill: AgentSkill): Promise<AgentProfile> {
  const profile = await getProfile();
  profile.skills = [...profile.skills.filter((s) => s.name !== skill.name), skill];
  await save(profile);
  return profile;
}

export async function removeSkill(name: string): Promise<AgentProfile> {
  const profile = await getProfile();
  profile.skills = profile.skills.filter((s) => s.name !== name);
  await save(profile);
  return profile;
}

/** Compose the full system instructions (base + learned skills) for the chat agent. */
export function composeInstructions(profile: AgentProfile): string {
  if (profile.skills.length === 0) return profile.instructions;
  const skills = profile.skills.map((s) => `### ${s.name}\n${s.content}`).join("\n\n");
  return `${profile.instructions}\n\n## Learned skills\n${skills}`;
}
