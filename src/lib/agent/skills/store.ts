import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { parseFrontmatter, buildFrontmatter, asString } from "@/lib/agent/subagents/markdown";

const DIR = path.join(process.cwd(), "data", "skills");
const SKILL_FILE = "SKILL.md";
const SCRIPTS_DIR = "scripts";
const REFERENCES_DIR = "references";

export interface SkillAsset {
  name: string;
  content: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  /** Reflective-optimizer score; higher = better-performing. */
  score?: number;
  /** Optional helper scripts attached to the skill. */
  scripts?: SkillAsset[];
  /** Optional reference documents attached to the skill. */
  references?: SkillAsset[];
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `skill-${Date.now().toString(36)}`;
}

function safeAssetName(name: string): string {
  const base = path.basename(name).trim();
  if (!base || base === "." || base === ".." || base.includes("/") || base.includes("\\")) {
    throw new Error(`Invalid asset name: ${name}`);
  }
  return base;
}

const SEED: Omit<Skill, "id">[] = [
  {
    name: "Summarize a web page",
    description: "Fetch a URL and produce a concise, faithful summary with key points.",
    whenToUse: "When the user asks what a web page or article says.",
    content: "1. Use web_fetch to load the URL.\n2. Identify the main thesis and 3-5 key points.\n3. Write a tight summary; do not invent facts; cite the URL.",
  },
  {
    name: "Modify BrowserOS",
    description: "Change BrowserOS itself — its built-in apps, Settings pages/tabs, desktop, or server logic — by delegating to the developer sub-agent.",
    whenToUse: "When the user asks to modify, change, edit, redesign, fix, or extend BrowserOS itself or any built-in part of it (e.g. the Settings Skills page, a Settings tab, the dock, an existing app's behavior).",
    content: [
      "Changing BrowserOS itself means editing its source code (a Next.js app). You do NOT have access to that source, and the virtual file system (listFiles/readFile/writeFile) is the user's sandboxed data — it does NOT contain BOS source. Do not go looking for BOS code in the VFS.",
      "",
      "1. Do NOT explore the codebase or VFS yourself, and do not try to \"understand how to implement\" first — you don't need to.",
      "2. Delegate the ENTIRE request to the 'developer' sub-agent: delegateToSubAgent with agent \"developer\". Give it a clear, complete description of what the user wants changed plus acceptance criteria. The developer has repo-scoped access — it finds the right files, edits them, typechecks, and stages the changes on a feature branch. Edits under src/ hot-reload in dev.",
      "3. If the request is large or vague, optionally delegate to the 'planner' sub-agent first for a breakdown, then hand that plan to the developer.",
      "4. When the developer reports back, summarize what changed and how to try it, and update docs with writeDoc if a feature or app changed.",
      "",
      "If the developer sub-agent or the Claude harness is unavailable, tell the user — never attempt to modify BOS through the VFS.",
    ].join("\n"),
  },
  {
    name: "Build App",
    description: "Build and install a new BrowserOS app by delegating to the Claude developer sub-agent, then installing the result with installApp.",
    whenToUse: "When the user asks to build, create, make, or prototype a new BrowserOS app.",
    content: [
      "Building an app is a development task. Use BrowserOS's standard sub-agent delegation — do NOT write the app yourself, and there is no dedicated \"build\" tool.",
      "",
      "1. Clarify the spec: core functionality, UI, data persistence, and whether it should call same-origin BrowserOS APIs (e.g. /api/fs). For a large or vague request, optionally delegate to the Planner sub-agent first for a task breakdown.",
      "2. Delegate the build to the Developer (Claude) sub-agent: call delegateToSubAgent with agent \"developer\". In the task, include the spec and require: a single self-contained index.html with all CSS/JS inline; no external dependencies, CDNs, or network calls (same-origin BrowserOS API calls are allowed); output ONLY the HTML document starting with <!doctype html>, and do not write files.",
      "3. Extract the HTML from the sub-agent's output; if wrapped in prose or a code fence, keep only the <!doctype html> … </html> document.",
      "4. Install it: call installApp with name, the full html, and an appropriate Lucide icon (e.g. Clock, Calculator, ListTodo, Music). installApp writes it to the VFS, adds it to the dock, and opens it.",
      "5. Document it with writeDoc: purpose, features, and how to use it.",
      "",
      "If the Claude harness / developer sub-agent is unavailable, tell the user — do not hand-write the app yourself.",
    ].join("\n"),
  },
];

let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  const existing = await listSkillIds();
  if (existing.length > 0) return;
  for (const s of SEED) await writeSkill({ id: slugify(s.name), ...s });
}

function toMarkdown(s: Skill): string {
  return buildFrontmatter(
    { name: s.name, description: s.description, when_to_use: s.whenToUse, score: s.score?.toString() },
    s.content,
  );
}

function fromMarkdown(id: string, src: string, extras: Partial<Pick<Skill, "scripts" | "references">> = {}): Skill {
  const { meta, body } = parseFrontmatter(src);
  return {
    id,
    name: asString(meta.name) || id,
    description: asString(meta.description) || "",
    whenToUse: asString(meta.when_to_use),
    content: body,
    score: meta.score ? Number(asString(meta.score)) : undefined,
    ...extras,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readAssetsDir(dir: string): Promise<SkillAsset[]> {
  if (!(await pathExists(dir))) return [];
  const files = (await fs.readdir(dir)).filter((f) => !f.startsWith("."));
  const out: SkillAsset[] = [];
  for (const name of files.sort()) {
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      out.push({ name, content: await fs.readFile(full, "utf8") });
    } catch {
      /* skip */
    }
  }
  return out;
}

async function writeAssetsDir(dir: string, assets: SkillAsset[] | undefined): Promise<void> {
  if (assets === undefined) return;
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir).catch(() => [])).filter((f) => !f.startsWith("."));
  const keep = new Set(assets.map((a) => safeAssetName(a.name)));
  for (const name of existing) {
    if (!keep.has(name)) await fs.rm(path.join(dir, name), { force: true });
  }
  for (const asset of assets) {
    const name = safeAssetName(asset.name);
    await fs.writeFile(path.join(dir, name), asset.content ?? "", "utf8");
  }
}

async function listSkillIds(): Promise<string[]> {
  const names = await fs.readdir(DIR).catch(() => [] as string[]);
  const ids = new Set<string>();
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = path.join(DIR, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (await pathExists(path.join(full, SKILL_FILE))) ids.add(name);
    } else if (stat.isFile() && name.endsWith(".md")) {
      ids.add(name.replace(/\.md$/, ""));
    }
  }
  return [...ids];
}

async function readSkillById(id: string, withAssets: boolean): Promise<Skill | undefined> {
  const dirPath = path.join(DIR, id);
  const dirFile = path.join(dirPath, SKILL_FILE);
  if (await pathExists(dirFile)) {
    const extras: Partial<Pick<Skill, "scripts" | "references">> = {};
    if (withAssets) {
      extras.scripts = await readAssetsDir(path.join(dirPath, SCRIPTS_DIR));
      extras.references = await readAssetsDir(path.join(dirPath, REFERENCES_DIR));
    }
    return fromMarkdown(id, await fs.readFile(dirFile, "utf8"), extras);
  }
  const flatFile = path.join(DIR, `${id}.md`);
  if (await pathExists(flatFile)) {
    const extras = withAssets ? { scripts: [] as SkillAsset[], references: [] as SkillAsset[] } : {};
    return fromMarkdown(id, await fs.readFile(flatFile, "utf8"), extras);
  }
  return undefined;
}

async function writeSkill(s: Skill): Promise<void> {
  const dirPath = path.join(DIR, s.id);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(path.join(dirPath, SKILL_FILE), toMarkdown(s), "utf8");
  await writeAssetsDir(path.join(dirPath, SCRIPTS_DIR), s.scripts);
  await writeAssetsDir(path.join(dirPath, REFERENCES_DIR), s.references);
  // Remove any legacy flat-file copy.
  const flatFile = path.join(DIR, `${s.id}.md`);
  if (await pathExists(flatFile)) await fs.rm(flatFile, { force: true });
}

export async function listSkills(): Promise<Skill[]> {
  await ensureSeed();
  const ids = await listSkillIds();
  const skills: Skill[] = [];
  for (const id of ids) {
    try {
      const s = await readSkillById(id, false);
      if (s) skills.push(s);
    } catch {
      /* skip */
    }
  }
  return skills;
}

export async function getSkill(idOrName: string): Promise<Skill | undefined> {
  await ensureSeed();
  const key = idOrName.toLowerCase();
  const direct = await readSkillById(key, true);
  if (direct) return direct;
  const ids = await listSkillIds();
  for (const id of ids) {
    const s = await readSkillById(id, true);
    if (s && (s.id.toLowerCase() === key || s.name.toLowerCase() === key)) return s;
  }
  return undefined;
}

export async function saveSkill(input: {
  name: string;
  description: string;
  content: string;
  whenToUse?: string;
  score?: number;
  scripts?: SkillAsset[];
  references?: SkillAsset[];
  /** When renaming an existing skill, pass its current id so the old directory is removed. */
  previousId?: string;
}): Promise<Skill> {
  await ensureSeed();
  const id = slugify(input.name);
  const skill: Skill = {
    id,
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    content: input.content,
    score: input.score,
    scripts: input.scripts,
    references: input.references,
  };
  await writeSkill(skill);
  if (input.previousId && input.previousId !== id) {
    await removeSkill(input.previousId);
  }
  return skill;
}

export async function removeSkill(idOrName: string): Promise<void> {
  const s = await getSkill(idOrName);
  if (!s) return;
  const dirPath = path.join(DIR, s.id);
  if (await pathExists(dirPath)) await fs.rm(dirPath, { recursive: true, force: true });
  const flatFile = path.join(DIR, `${s.id}.md`);
  if (await pathExists(flatFile)) await fs.rm(flatFile, { force: true });
}
