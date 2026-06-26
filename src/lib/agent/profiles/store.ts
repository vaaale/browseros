import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_PERSONALITY } from "@/lib/agent/config";
import { parseFrontmatter, buildFrontmatter, asString } from "@/lib/agent/subagents/markdown";
import { readNamespace, patchNamespace } from "@/lib/config/store";

const DIR = path.join(process.cwd(), "data", "profiles");

export interface Profile {
  id: string;
  name: string;
  description: string;
  body: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
}

let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  const existing = await fs.readdir(DIR).catch(() => []);
  if (existing.length > 0) return;
  await fs.mkdir(path.join(DIR, "default"), { recursive: true });
  await fs.writeFile(
    path.join(DIR, "default", "PROFILE.md"),
    buildFrontmatter({ name: "Default", description: "Balanced BrowserOS assistant." }, DEFAULT_PERSONALITY),
    "utf8",
  );
}

/** Compose a profile's instructions from PROFILE.md plus any extra .md files. */
async function readProfileBody(id: string): Promise<{ name: string; description: string; body: string }> {
  const dir = path.join(DIR, id);
  const main = await fs.readFile(path.join(dir, "PROFILE.md"), "utf8");
  const { meta, body } = parseFrontmatter(main);
  const extraFiles = (await fs.readdir(dir).catch(() => []))
    .filter((f) => f.endsWith(".md") && f !== "PROFILE.md")
    .sort();
  const extras = await Promise.all(extraFiles.map((f) => fs.readFile(path.join(dir, f), "utf8")));
  return {
    name: asString(meta.name) || id,
    description: asString(meta.description) || "",
    body: [body, ...extras.map((e) => e.trim())].filter(Boolean).join("\n\n"),
  };
}

export async function listProfiles(): Promise<Profile[]> {
  await ensureSeed();
  const dirs = await fs.readdir(DIR, { withFileTypes: true }).catch(() => []);
  const out: Profile[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      out.push({ id: d.name, ...(await readProfileBody(d.name)) });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function getActiveProfileId(): Promise<string> {
  const cfg = await readNamespace("assistant");
  return (cfg.activeProfile as string) || "default";
}

export async function setActiveProfileId(id: string): Promise<void> {
  await patchNamespace("assistant", { activeProfile: id });
}

export async function createProfile(input: { name: string; description?: string; body: string }): Promise<Profile> {
  await ensureSeed();
  const id = slugify(input.name);
  await fs.mkdir(path.join(DIR, id), { recursive: true });
  await fs.writeFile(
    path.join(DIR, id, "PROFILE.md"),
    buildFrontmatter({ name: input.name, description: input.description ?? "" }, input.body),
    "utf8",
  );
  return { id, name: input.name, description: input.description ?? "", body: input.body };
}

export async function updateActiveProfileBody(body: string): Promise<void> {
  await ensureSeed();
  const id = await getActiveProfileId();
  const dir = path.join(DIR, id);
  const { name, description } = await readProfileBody(id).catch(() => ({ name: id, description: "" }));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "PROFILE.md"), buildFrontmatter({ name, description }, body), "utf8");
}

export async function getActiveProfileBody(): Promise<string> {
  await ensureSeed();
  const id = await getActiveProfileId();
  try {
    return (await readProfileBody(id)).body;
  } catch {
    return DEFAULT_PERSONALITY;
  }
}
