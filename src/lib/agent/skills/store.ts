import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { parseFrontmatter, buildFrontmatter, asString } from "@/lib/agent/subagents/markdown";

const DIR = path.join(process.cwd(), "data", "skills");

export interface Skill {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  /** Reflective-optimizer score; higher = better-performing. */
  score?: number;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `skill-${Date.now().toString(36)}`;
}

const SEED: Omit<Skill, "id">[] = [
  {
    name: "Summarize a web page",
    description: "Fetch a URL and produce a concise, faithful summary with key points.",
    whenToUse: "When the user asks what a web page or article says.",
    content: "1. Use web_fetch to load the URL.\n2. Identify the main thesis and 3-5 key points.\n3. Write a tight summary; do not invent facts; cite the URL.",
  },
];

let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  const existing = (await fs.readdir(DIR).catch(() => [])).filter((f) => f.endsWith(".md"));
  if (existing.length > 0) return;
  for (const s of SEED) await writeSkill({ id: slugify(s.name), ...s });
}

function toMarkdown(s: Skill): string {
  return buildFrontmatter(
    { name: s.name, description: s.description, when_to_use: s.whenToUse, score: s.score?.toString() },
    s.content,
  );
}

async function writeSkill(s: Skill): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${s.id}.md`), toMarkdown(s), "utf8");
}

function fromMarkdown(id: string, src: string): Skill {
  const { meta, body } = parseFrontmatter(src);
  return {
    id,
    name: asString(meta.name) || id,
    description: asString(meta.description) || "",
    whenToUse: asString(meta.when_to_use),
    content: body,
    score: meta.score ? Number(asString(meta.score)) : undefined,
  };
}

export async function listSkills(): Promise<Skill[]> {
  await ensureSeed();
  const files = (await fs.readdir(DIR).catch(() => [])).filter((f) => f.endsWith(".md"));
  const skills: Skill[] = [];
  for (const f of files) {
    try {
      skills.push(fromMarkdown(f.replace(/\.md$/, ""), await fs.readFile(path.join(DIR, f), "utf8")));
    } catch {
      /* skip */
    }
  }
  return skills;
}

export async function getSkill(idOrName: string): Promise<Skill | undefined> {
  const key = idOrName.toLowerCase();
  return (await listSkills()).find((s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key);
}

export async function saveSkill(input: {
  name: string;
  description: string;
  content: string;
  whenToUse?: string;
  score?: number;
}): Promise<Skill> {
  await ensureSeed();
  const skill: Skill = { id: slugify(input.name), ...input };
  await writeSkill(skill);
  return skill;
}

export async function removeSkill(idOrName: string): Promise<void> {
  const s = await getSkill(idOrName);
  if (s) await fs.rm(path.join(DIR, `${s.id}.md`), { force: true });
}
