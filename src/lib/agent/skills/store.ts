import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { parseFrontmatter, buildFrontmatter, asString } from "@/lib/agent/subagents/markdown";
import { reconcileInstalledItemAssets } from "@/system/marketplace/install/bundledAssets";
import { archiveSeededDir, decideSeedAction, readSeedStamp, seedRev, writeSeedStamp } from "@/lib/agent/seed-sync";

/** Resolved per call, NOT captured at module scope — `dataDir()` is env-driven
 *  and changes at runtime (branch clone, per-user container). */
function skillsDir(): string {
  return path.join(dataDir(), "skills");
}
// Root of the seed directory. Each subfolder contains a SKILL.md (+ optional
// scripts/, references/) copied into data/skills/ on first install (additive —
// never overwrites edits or later user/agent-created skills of the same id).
// Mirrors subagents/store.ts's SEED_DIR pattern for agents.
const SEED_DIR = path.join(process.cwd(), "seed", "skills");
const SKILL_FILE = "SKILL.md";
const SCRIPTS_DIR = "scripts";
const REFERENCES_DIR = "references";

export interface SkillAsset {
  /** A bare file name for `scripts`/`references`; a RELATIVE PATH for `files`
   *  (e.g. `assets/prd-template.md`). */
  name: string;
  content: string;
}

/**
 * Everything else in the skill directory (048 FR-024).
 *
 * `scripts/` and `references/` were the only two subdirectories this MODEL knew,
 * and a third framework immediately needed six more: BMAD's 30 skills use
 * `assets/` (26 template files), `review-prompts/`, `steps/`, `templates/`,
 * `agents/`, a root `customize.toml` on 27 of them, and loose root files like
 * `workflow.md`.
 *
 * **What was and was not broken, because the first version of this comment got
 * it wrong.** Installing a pack was always fine: `copyAsset` does a recursive
 * `fs.cp` into `data/skills/<id>`, and `listSkillFiles`/`readSkillFile` walk
 * whatever is there — so an agent could always READ a template. The gap was in
 * the object model around it:
 *
 *   - `getSkill()` reported a skill as SKILL.md + scripts + references, so every
 *     consumer reasoning about "what is in this skill" saw a partial answer;
 *   - `skillRevParts` hashed only those, so a change confined to a template did
 *     not count as a change;
 *   - `seedFromDiskPath` — BOS's own `seed/skills/` reconciliation — carried only
 *     those, so a BMAD-shaped skill shipped in-tree would arrive truncated.
 *
 * The fix is not to add "assets" to the list, which would carry the templates and
 * silently drop the other five kinds — the allowlist failure this codebase
 * produced twice in one day (a store manifest losing `workflow`, and a pack
 * declaring a templates dir nobody checked). The rule is inverted: carry the
 * directory as it IS, and let a pack organise itself however it likes.
 *
 * Text only, like `scripts`/`references` before it — every asset the three
 * shipped packs use is `.md`, `.csv`, `.html`, `.json` or `.toml`. A binary
 * asset would need base64 and there is nothing to justify it yet.
 */
const CARRIED_SUBDIRS = new Set([SCRIPTS_DIR, REFERENCES_DIR]);
const SKIP_DIRS = new Set(["__pycache__", "node_modules", ".git"]);

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
  /** Every OTHER file in the skill directory, keyed by relative path — a pack's
   *  own layout, carried verbatim rather than matched against a list of
   *  directory names BOS happens to know (048 FR-024). */
  files?: SkillAsset[];
  /** Provenance — governs the Curator lifecycle. Defaults to "agent". */
  createdBy?: "agent" | "user" | "seed";
  /** Pinned skills are exempt from Curator auto-archive/consolidation. */
  pinned?: boolean;
  /** True when `data/skills/<id>` is a SYMLINK into an installed item
   *  (`../system/<itemId>/…`). The content lives in the item's marketplace
   *  source, so every mutation here refuses — update or uninstall the item
   *  instead. Derived from the filesystem per read, never stored. */
  readOnly?: boolean;
  /** The installed item the symlink routes through, when it can be read off
   *  the link text. */
  sourceItemId?: string;
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
 * (`bos-domain/references/target-marketplace-item.md`), which a SKILL.md-only
 * hash would have missed. Names are included so adding or renaming an asset
 * counts as a change.
 */
function skillRevParts(skillMd: string, scripts: SkillAsset[], references: SkillAsset[], files: SkillAsset[] = []): string[] {
  const parts = [skillMd];
  // `files` is included for the same reason references were: this session's real
  // case was a change confined to one asset, and a hash that misses it means an
  // edited template never re-seeds — the skill looks current and is not.
  for (const [kind, assets] of [["scripts", scripts], ["references", references], ["files", files]] as const) {
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
    skillRevParts(
      skillMd,
      await readAssetsDir(path.join(dirPath, SCRIPTS_DIR)),
      await readAssetsDir(path.join(dirPath, REFERENCES_DIR)),
      await readSkillFiles(dirPath),
    ),
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
  const dirPath = path.join(skillsDir(), id);
  // The legacy flat-file form (skillsDir()/id.md) is never reconciled — it predates
  // both the directory layout and the stamp, so it can only be treated as local.
  if (await pathExists(path.join(skillsDir(), `${id}.md`))) return;
  const scripts = await readAssetsDir(path.join(skillDir, SCRIPTS_DIR));
  const references = await readAssetsDir(path.join(skillDir, REFERENCES_DIR));
  const files = await readSkillFiles(skillDir);
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
    files,
  };
  // Two distinct hashes (see seed-sync.ts): what the SEED holds, and what BOS
  // actually writes. They differ for every skill, because writeSkill
  // re-serializes the frontmatter rather than copying the seed file.
  const seedContentRev = seedRev(skillRevParts(raw, scripts, references, files));
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
  const entries = await fs.readdir(skillsDir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (seedIds.has(entry.name)) continue;
    const dirPath = path.join(skillsDir(), entry.name);
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

// Tracked PER DATA ROOT, not per process. `dataDir()` is env-driven and BOS
// changes it at runtime (a feature-branch data clone, a per-user container), so
// a single boolean meant only the FIRST root ever got seeded — after switching
// roots, the seeded agents/skills would silently never appear there.
const seededRoots = new Set<string>();
async function ensureSeed(): Promise<void> {
  const root = skillsDir();
  if (seededRoots.has(root)) return;
  seededRoots.add(root);
  await fs.mkdir(root, { recursive: true });
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

  // 046 T008 / FR-008b — method packs' bundled skills.
  //
  // AFTER the archive above, and as its OWN step rather than riding
  // reconcileInstalledItemAssets() below. That pass is memoized per data root
  // and the AGENT store consumes it first (subagents/store.ts), so a skill
  // archived here could never be re-seeded in the same process: the memo would
  // already be resolved from before the archive ran. That is precisely the
  // defect that would leave a deployment with the driver skill archived and
  // nothing put back — Build Studio with no pipeline at all.
  //
  // Kind-scoped on purpose: the pack's AGENTS are discovered from its root in
  // place (045 FR-001), never copied into data/agents/.
  await seedMethodPackSkills();

  // Marketplace items may bundle their own skills (040-okf-knowledge-base) —
  // reconciled here for the same reason the agent store does it: an
  // already-installed item that gains a skill would otherwise never surface it.
  // Memoized across both stores, so this scan runs once per process.
  await reconcileInstalledItemAssets();
}

/** Copy every registered method pack's bundled skills into `data/skills/`.
 *
 *  Skills are COPIED where agents are DISCOVERED. The asymmetry is real and
 *  deliberate: skill resolution has a single root today, so a pack skill has to
 *  land in it to be loadable at all, while agent discovery is already
 *  multi-root (045 FR-001). Converging the two on multi-root skills is the
 *  eventual fix; until then this step is what makes a pack's driver skill
 *  reachable, and it reconciles by the bundled-asset provenance contract
 *  (replace when untouched, conflict when diverged) rather than by `.seed-rev`. */
async function seedMethodPackSkills(): Promise<void> {
  const { listMethods, methodPackRoot } = await import("@/lib/specs/method/registry");
  const { ensureBuiltinMethod } = await import("@/lib/specs/method/resolve");
  const { seedPackBundledSkills } = await import("@/system/marketplace/install/bundledAssets");
  ensureBuiltinMethod();
  for (const method of listMethods()) {
    const root = methodPackRoot(method.id);
    if (!root) continue; // a descriptor registered without a source root has no skills to seed
    await seedPackBundledSkills(root, method.id, method.version).catch(() => {
      // Best-effort, like every other seeding step: a pack whose skills cannot
      // be read must not stop the rest of the skill library from loading.
    });
  }
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

/** A relative path that stays inside the skill directory. Rejects absolute
 *  paths, `..` and backslashes — the same jail `safeAssetName` gives a flat
 *  name, extended to the nested ones a pack's own layout needs. */
function safeRelPath(rel: string): string {
  const normalised = path.normalize(rel).replace(/\\/g, "/");
  if (!normalised || path.isAbsolute(normalised) || normalised.split("/").some((p) => p === "..")) {
    throw new Error(`Invalid asset path: ${rel}`);
  }
  return normalised;
}

/**
 * Every file under the skill directory that is not `SKILL.md` and not already
 * carried by `scripts`/`references`, keyed by relative path.
 *
 * Recursive, and deliberately without a list of expected directory names — see
 * CARRIED_SUBDIRS' note. `__pycache__` is skipped because BMAD's scripts are
 * Python and a byte-cache is build output, not content; a dotfile is skipped for
 * the same reason it is everywhere else here.
 */
async function readSkillFiles(dir: string, rel = ""): Promise<SkillAsset[]> {
  const full = rel ? path.join(dir, rel) : dir;
  // NOT `.catch(() => [])`: a skill directory that cannot be READ is not one
  // with no extra files, and treating it as empty would drop a pack's templates
  // and report success.
  let entries;
  try {
    entries = await fs.readdir(full, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: SkillAsset[] = [];
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      // Only at the TOP level: a nested `scripts/` inside `steps/` is ordinary
      // content and must be carried.
      if (!rel && CARRIED_SUBDIRS.has(e.name)) continue;
      out.push(...(await readSkillFiles(dir, childRel)));
      continue;
    }
    if (!e.isFile()) continue;
    if (!rel && e.name === SKILL_FILE) continue;
    out.push({ name: childRel, content: await fs.readFile(path.join(dir, childRel), "utf8") });
  }
  return out;
}

/** Write `files` under the skill directory, removing tracked files that are no
 *  longer present. Scoped to what `readSkillFiles` would return, so it can never
 *  delete SKILL.md, `scripts/` or `references/`. */
async function writeSkillFiles(dir: string, files: SkillAsset[] | undefined): Promise<void> {
  if (files === undefined) return;
  const keep = new Set(files.map((f) => safeRelPath(f.name)));
  for (const existing of await readSkillFiles(dir)) {
    if (!keep.has(existing.name)) await fs.rm(path.join(dir, existing.name), { force: true });
  }
  for (const f of files) {
    const rel = safeRelPath(f.name);
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, f.content ?? "");
  }
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
  const names = await fs.readdir(skillsDir()).catch(() => [] as string[]);
  const ids = new Set<string>();
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = path.join(skillsDir(), name);
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

/**
 * Read-only detection for one skill directory. Keyed on the SYMLINK ITSELF —
 * not on where it resolves — because the guard must hold even for a link whose
 * text this code did not write (an absolute target, a hand-made link): any
 * write through a symlink lands outside data/skills/, typically inside a
 * marketplace clone that `git pull` owns.
 */
async function skillLinkInfo(id: string): Promise<{ readOnly: boolean; sourceItemId?: string }> {
  const p = path.join(skillsDir(), id);
  const st = await fs.lstat(p).catch(() => null);
  if (!st?.isSymbolicLink()) return { readOnly: false };
  const link = await fs.readlink(p).catch(() => null);
  const parts = link ? path.normalize(link).split(path.sep) : [];
  const sourceItemId = parts[0] === ".." && parts[1] === "system" && parts[2] ? parts[2] : undefined;
  return { readOnly: true, sourceItemId };
}

function readOnlySkillError(id: string, sourceItemId?: string): Error {
  const from = sourceItemId ? ` — it is installed from item "${sourceItemId}"` : "";
  return new Error(
    `Skill "${id}" is read-only${from}: its content lives in the installed item's source. ` +
      `Update or uninstall the item instead, or duplicate the skill under a new name to edit it.`,
  );
}

async function readSkillById(id: string, withAssets: boolean): Promise<Skill | undefined> {
  const dirPath = path.join(skillsDir(), id);
  const dirFile = path.join(dirPath, SKILL_FILE);
  if (await pathExists(dirFile)) {
    const extras: Partial<Pick<Skill, "scripts" | "references" | "files">> = {};
    if (withAssets) {
      extras.scripts = await readAssetsDir(path.join(dirPath, SCRIPTS_DIR));
      extras.references = await readAssetsDir(path.join(dirPath, REFERENCES_DIR));
      extras.files = await readSkillFiles(dirPath);
    }
    const skill = fromMarkdown(id, await fs.readFile(dirFile, "utf8"), extras);
    const { readOnly, sourceItemId } = await skillLinkInfo(id);
    if (readOnly) {
      skill.readOnly = true;
      skill.sourceItemId = sourceItemId;
    }
    return skill;
  }
  const flatFile = path.join(skillsDir(), `${id}.md`);
  if (await pathExists(flatFile)) {
    const extras = withAssets ? { scripts: [] as SkillAsset[], references: [] as SkillAsset[], files: [] as SkillAsset[] } : {};
    return fromMarkdown(id, await fs.readFile(flatFile, "utf8"), extras);
  }
  return undefined;
}

async function writeSkill(s: Skill): Promise<void> {
  // The LAST line of defence, so every caller is covered: a write through a
  // symlinked skill dir would land inside the installed item's source.
  const info = await skillLinkInfo(s.id);
  if (info.readOnly) throw readOnlySkillError(s.id, info.sourceItemId);
  const dirPath = path.join(skillsDir(), s.id);
  await fs.mkdir(dirPath, { recursive: true });
  await writeFileAtomic(path.join(dirPath, SKILL_FILE), toMarkdown(s));
  await writeAssetsDir(path.join(dirPath, SCRIPTS_DIR), s.scripts);
  await writeAssetsDir(path.join(dirPath, REFERENCES_DIR), s.references);
  await writeSkillFiles(dirPath, s.files);
  // Remove any legacy flat-file copy.
  const flatFile = path.join(skillsDir(), `${s.id}.md`);
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
  const dir = path.join(skillsDir(), skill.id);
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
  // dereference: a symlinked (item-installed) skill must be staged as REAL
  // files — reproducing the link in a sandbox leaves `../system/<id>/…`
  // resolving to nothing, and every script path in the skill breaks.
  await fs.cp(dir, destDir, { recursive: true, dereference: true });
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

const ARCHIVE_DIR = path.join(skillsDir(), ".archive");

/** Targeted edit: replace the first occurrence of `find` in the skill body. */
export async function patchSkill(idOrName: string, find: string, replace: string): Promise<Skill | { error: string }> {
  const skill = await getSkill(idOrName);
  if (!skill) return { error: `No skill "${idOrName}".` };
  // Through the error channel, not a throw — this is the LLM tool surface, and
  // the model needs the "duplicate it to edit it" recovery path in-band.
  if (skill.readOnly) return { error: readOnlySkillError(skill.id, skill.sourceItemId).message };
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
  // An installed item's skill is not the Curator's to archive — renaming the
  // symlink into .archive/ would just dangle there while the next reconcile
  // pass re-links the skill anyway. Uninstalling the item is the removal path.
  if (skill.readOnly) return false;
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const to = path.join(ARCHIVE_DIR, skill.id);
  await fs.rm(to, { recursive: true, force: true }).catch(() => {});
  const dir = path.join(skillsDir(), skill.id);
  if (await pathExists(dir)) {
    await fs.rename(dir, to);
    return true;
  }
  const flat = path.join(skillsDir(), `${skill.id}.md`);
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
  await fs.rename(from, path.join(skillsDir(), id));
  return true;
}

export async function listArchivedIds(): Promise<string[]> {
  return (await fs.readdir(ARCHIVE_DIR).catch(() => [])).filter((n) => !n.startsWith("."));
}

export async function removeSkill(idOrName: string): Promise<void> {
  const s = await getSkill(idOrName);
  if (!s) return;
  if (s.readOnly) throw readOnlySkillError(s.id, s.sourceItemId);
  const dirPath = path.join(skillsDir(), s.id);
  if (await pathExists(dirPath)) await fs.rm(dirPath, { recursive: true, force: true });
  const flatFile = path.join(skillsDir(), `${s.id}.md`);
  if (await pathExists(flatFile)) await fs.rm(flatFile, { force: true });
}
