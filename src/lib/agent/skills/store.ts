import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { parseFrontmatter, buildFrontmatter, asString } from "@/lib/agent/subagents/markdown";
import { reconcileInstalledItemAssets } from "@/system/marketplace/install/bundledAssets";
import { archiveSeededDir, decideSeedAction, readSeedStamp, seedRev, writeSeedStamp } from "@/lib/agent/seed-sync";

const DIR = path.join(dataDir(), "skills");
// Root of the seed directory. Each subfolder contains a SKILL.md (+ optional
// scripts/, references/) copied into data/skills/ on first install (additive —
// never overwrites edits or later user/agent-created skills of the same id).
// Mirrors subagents/store.ts's SEED_DIR pattern for agents.
const SEED_DIR = path.join(process.cwd(), "seed", "skills");
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
  /** Provenance — governs the Curator lifecycle. Defaults to "agent". */
  createdBy?: "agent" | "user" | "seed";
  /** Pinned skills are exempt from Curator auto-archive/consolidation. */
  pinned?: boolean;
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

/**
 * The bytes a skill is made of, for hashing. A skill isn't one file — its
 * references and scripts are as much a part of it as SKILL.md, and this
 * session's real case was a change confined entirely to a reference document
 * (`build-studio/references/target-marketplace-item.md`), which a SKILL.md-only
 * hash would have missed. Names are included so adding or renaming an asset
 * counts as a change.
 */
function skillRevParts(skillMd: string, scripts: SkillAsset[], references: SkillAsset[]): string[] {
  const parts = [skillMd];
  for (const [kind, assets] of [["scripts", scripts], ["references", references]] as const) {
    for (const a of [...assets].sort((x, y) => x.name.localeCompare(y.name))) {
      parts.push(`${kind}/${a.name}`, a.content);
    }
  }
  return parts;
}

/** Hash of the skill as it currently sits in data/skills/<id>/. */
async function liveSkillRev(dirPath: string): Promise<string | undefined> {
  const skillMd = await fs.readFile(path.join(dirPath, SKILL_FILE), "utf8").catch(() => null);
  if (skillMd === null) return undefined;
  return seedRev(
    skillRevParts(skillMd, await readAssetsDir(path.join(dirPath, SCRIPTS_DIR)), await readAssetsDir(path.join(dirPath, REFERENCES_DIR))),
  );
}

/**
 * Reconcile one seed skill into data/skills/: write it when absent, refresh it
 * when BOS's own copy is untouched and the seed has moved on, and never touch
 * one that was edited locally — `skill_improve`'s reflective optimizer rewrites
 * content and score in place, and that must always win over the shipped text.
 *
 * Unlike agents, a seeded skill is RE-SERIALIZED rather than copied verbatim
 * (`writeSkill` adds `created_by`, splits assets into subfolders), so the
 * revision is hashed over what BOS actually writes, not over the seed file.
 */
async function seedFromDiskPath(skillDir: string): Promise<void> {
  const skillFile = path.join(skillDir, SKILL_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(skillFile, "utf8");
  } catch {
    return;
  }
  const { meta, body } = parseFrontmatter(raw);
  const name = asString(meta.name) || path.basename(skillDir);
  const id = slugify(name);
  const dirPath = path.join(DIR, id);
  // The legacy flat-file form (DIR/id.md) is never reconciled — it predates
  // both the directory layout and the stamp, so it can only be treated as local.
  if (await pathExists(path.join(DIR, `${id}.md`))) return;
  const scripts = await readAssetsDir(path.join(skillDir, SCRIPTS_DIR));
  const references = await readAssetsDir(path.join(skillDir, REFERENCES_DIR));
  const skill: Skill = {
    id,
    name,
    description: asString(meta.description) || "",
    whenToUse: asString(meta.when_to_use),
    content: body,
    createdBy: "seed",
    pinned: asString(meta.pinned) === "true",
    scripts,
    references,
  };
  // Two distinct hashes (see seed-sync.ts): what the SEED holds, and what BOS
  // actually writes. They differ for every skill, because writeSkill
  // re-serializes the frontmatter rather than copying the seed file.
  const seedContentRev = seedRev(skillRevParts(raw, scripts, references));
  const action = decideSeedAction({
    inSeed: true,
    liveRev: await liveSkillRev(dirPath),
    stamp: await readSeedStamp(dirPath),
    seedRev: seedContentRev,
  });
  if (action !== "seed" && action !== "update") return;
  await writeSkill(skill);
  // Nothing rewrites a skill after this point (unlike agents), so the written
  // bytes can be hashed straight back.
  const live = await liveSkillRev(dirPath);
  if (live) await writeSeedStamp(dirPath, { seed: seedContentRev, live });
}

/**
 * Archive skills BOS seeded that the seed no longer ships. Same contract as the
 * agent side: only a stamped, unedited copy is ever moved, and an empty seed
 * listing is treated as "couldn't read it", never as "everything was deleted".
 */
async function archiveDroppedSeedSkills(seedIds: Set<string>): Promise<void> {
  if (seedIds.size === 0) return;
  const entries = await fs.readdir(DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (seedIds.has(entry.name)) continue;
    const dirPath = path.join(DIR, entry.name);
    const action = decideSeedAction({
      inSeed: false,
      liveRev: await liveSkillRev(dirPath),
      stamp: await readSeedStamp(dirPath),
    });
    if (action === "archive") await archiveSeededDir(dirPath, ARCHIVE_DIR, entry.name);
  }
}

/** The ids `seed/skills/` currently ships, resolved the same way seeding does. */
async function listSeedSkillIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const entries = await fs.readdir(SEED_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await fs.readFile(path.join(SEED_DIR, entry.name, SKILL_FILE), "utf8").catch(() => null);
    if (raw === null) continue;
    ids.add(slugify(asString(parseFrontmatter(raw).meta.name) || entry.name));
  }
  return ids;
}

let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  // Every subfolder of seed/skills/ is reconciled into data/skills/: seeded when
  // absent, refreshed when BOS's own copy is untouched and the shipped version
  // has changed, archived when the seed drops it, and left strictly alone once
  // anything local has edited it. Mirrors subagents/store.ts's agent seeding
  // exactly — see seed-sync.ts for why a stamp is needed to tell those apart.
  const entries = await fs.readdir(SEED_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await seedFromDiskPath(path.join(SEED_DIR, entry.name));
  }
  await archiveDroppedSeedSkills(await listSeedSkillIds());
  // Marketplace items may bundle their own skills (040-okf-knowledge-base) —
  // reconciled here for the same reason the agent store does it: an
  // already-installed item that gains a skill would otherwise never surface it.
  // Memoized across both stores, so this scan runs once per process.
  await reconcileInstalledItemAssets();
}

function toMarkdown(s: Skill): string {
  return buildFrontmatter(
    {
      name: s.name,
      description: s.description,
      when_to_use: s.whenToUse,
      score: s.score?.toString(),
      created_by: s.createdBy,
      pinned: s.pinned ? "true" : undefined,
    },
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
    createdBy: (asString(meta.created_by) as Skill["createdBy"]) || undefined,
    pinned: asString(meta.pinned) === "true",
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
    if (!keep.has(name)) await fs.rm(path.join(dir, name), { force: true, recursive: true });
  }
  for (const asset of assets) {
    const name = safeAssetName(asset.name);
    await writeFileAtomic(path.join(dir, name), asset.content ?? "");
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
  await writeFileAtomic(path.join(dirPath, SKILL_FILE), toMarkdown(s));
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

// LLM tool callers occasionally invent a namespace prefix (e.g. "skill:foo")
// even when told to copy the id verbatim — strip it defensively so lookups
// don't fail on an otherwise-correct id.
function normalizeSkillRef(idOrName: string): string {
  return idOrName.trim().replace(/^skills?:\s*/i, "");
}

export async function getSkill(idOrName: string): Promise<Skill | undefined> {
  await ensureSeed();
  const key = normalizeSkillRef(idOrName).toLowerCase();
  const direct = await readSkillById(key, true);
  if (direct) return direct;
  const ids = await listSkillIds();
  for (const id of ids) {
    const s = await readSkillById(id, true);
    if (s && (s.id.toLowerCase() === key || s.name.toLowerCase() === key)) return s;
  }
  return undefined;
}

/** Resolve a skill's on-disk directory by id or name (undefined if not found or
 *  the skill is a legacy flat-file with no bundled resources). */
async function skillDir(idOrName: string): Promise<string | undefined> {
  const skill = await getSkill(idOrName);
  if (!skill) return undefined;
  const dir = path.join(DIR, skill.id);
  return (await pathExists(path.join(dir, SKILL_FILE))) ? dir : undefined;
}

/** Progressive disclosure: read a bundled file from a skill's directory by
 *  relative path — a reference doc, a script, or any sibling of SKILL.md (e.g.
 *  pptx keeps `editing.md` / `scripts/thumbnail.py`). Path-guarded to the skill
 *  directory so the model can't traverse out of it. */
export async function readSkillFile(idOrName: string, relPath: string): Promise<string> {
  const dir = await skillDir(idOrName);
  if (!dir) throw new Error(`No skill "${idOrName}" (or it has no bundled files).`);
  const abs = path.resolve(dir, relPath);
  const rel = path.relative(dir, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes skill directory: ${relPath}`);
  }
  return fs.readFile(abs, "utf8");
}

/** List a skill's bundled files (relative paths, excluding SKILL.md itself) so
 *  the agent can discover references/scripts to read with readSkillFile. */
export async function listSkillFiles(idOrName: string): Promise<string[]> {
  const base = await skillDir(idOrName);
  if (!base) return [];
  const root: string = base;
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (!(d === root && e.name === SKILL_FILE)) out.push(path.relative(root, full));
    }
  }
  await walk(root);
  return out.sort();
}

/** Copy a skill's bundled files (SKILL.md, scripts/, references, siblings) INTO
 *  destDir so a sandbox can run the skill's scripts with the relative paths its
 *  SKILL.md uses (e.g. `python scripts/office/unpack.py`). Returns false if the
 *  skill has no bundled directory. */
export async function stageSkillFiles(idOrName: string, destDir: string): Promise<boolean> {
  const dir = await skillDir(idOrName);
  if (!dir) return false;
  await fs.mkdir(destDir, { recursive: true });
  await fs.cp(dir, destDir, { recursive: true });
  return true;
}

export async function saveSkill(input: {
  name: string;
  description: string;
  content: string;
  whenToUse?: string;
  score?: number;
  scripts?: SkillAsset[];
  references?: SkillAsset[];
  createdBy?: Skill["createdBy"];
  pinned?: boolean;
  /** When renaming an existing skill, pass its current id so the old directory is removed. */
  previousId?: string;
}): Promise<Skill> {
  await ensureSeed();
  const id = slugify(input.name);
  // Preserve provenance/pin across edits unless explicitly overridden.
  const prior = await readSkillById(input.previousId ?? id, false).catch(() => undefined);
  const skill: Skill = {
    id,
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    content: input.content,
    score: input.score,
    scripts: input.scripts,
    references: input.references,
    createdBy: input.createdBy ?? prior?.createdBy ?? "agent",
    pinned: input.pinned ?? prior?.pinned ?? false,
  };
  await writeSkill(skill);
  if (input.previousId && input.previousId !== id) {
    await removeSkill(input.previousId);
  }
  return skill;
}

const ARCHIVE_DIR = path.join(DIR, ".archive");

/** Targeted edit: replace the first occurrence of `find` in the skill body. */
export async function patchSkill(idOrName: string, find: string, replace: string): Promise<Skill | { error: string }> {
  const skill = await getSkill(idOrName);
  if (!skill) return { error: `No skill "${idOrName}".` };
  if (!skill.content.includes(find)) return { error: `Search text not found in "${skill.name}".` };
  return saveSkill({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    content: skill.content.replace(find, replace),
    score: skill.score,
    scripts: skill.scripts,
    references: skill.references,
  });
}

export async function setSkillPinned(idOrName: string, pinned: boolean): Promise<Skill | undefined> {
  const skill = await getSkill(idOrName);
  if (!skill) return undefined;
  return saveSkill({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    content: skill.content,
    score: skill.score,
    scripts: skill.scripts,
    references: skill.references,
    pinned,
  });
}

/** Archive (never delete) — moves the skill under data/skills/.archive/<id>. Restorable. */
export async function archiveSkill(idOrName: string): Promise<boolean> {
  const skill = await getSkill(idOrName);
  if (!skill) return false;
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const to = path.join(ARCHIVE_DIR, skill.id);
  await fs.rm(to, { recursive: true, force: true }).catch(() => {});
  const dir = path.join(DIR, skill.id);
  if (await pathExists(dir)) {
    await fs.rename(dir, to);
    return true;
  }
  const flat = path.join(DIR, `${skill.id}.md`);
  if (await pathExists(flat)) {
    await fs.mkdir(to, { recursive: true });
    await fs.rename(flat, path.join(to, SKILL_FILE));
    return true;
  }
  return false;
}

export async function restoreSkill(id: string): Promise<boolean> {
  const from = path.join(ARCHIVE_DIR, id);
  if (!(await pathExists(from))) return false;
  await fs.rename(from, path.join(DIR, id));
  return true;
}

export async function listArchivedIds(): Promise<string[]> {
  return (await fs.readdir(ARCHIVE_DIR).catch(() => [])).filter((n) => !n.startsWith("."));
}

export async function removeSkill(idOrName: string): Promise<void> {
  const s = await getSkill(idOrName);
  if (!s) return;
  const dirPath = path.join(DIR, s.id);
  if (await pathExists(dirPath)) await fs.rm(dirPath, { recursive: true, force: true });
  const flatFile = path.join(DIR, `${s.id}.md`);
  if (await pathExists(flatFile)) await fs.rm(flatFile, { force: true });
}
