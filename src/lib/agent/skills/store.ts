import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { parseFrontmatter, buildFrontmatter, asString } from "@/lib/agent/subagents/markdown";

const DIR = path.join(dataDir(), "skills");
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

const SEED: Omit<Skill, "id">[] = [
  {
    name: "Summarize a web page",
    description: "Fetch a URL and produce a concise, faithful summary with key points.",
    whenToUse: "When the user asks what a web page or article says.",
    content: "1. Use web_fetch to load the URL.\n2. Identify the main thesis and 3-5 key points.\n3. Write a tight summary; do not invent facts; cite the URL.",
  },
  {
    name: "Develop in BrowserOS",
    description: "Build an app that runs in BOS, or modify BOS itself (built-in apps, Settings, desktop, or server logic). The work is delegated to the Claude developer sub-agent.",
    whenToUse: "When the user asks to build/create/make an app in BOS, OR to modify/change/edit/redesign/fix/extend BOS itself or any built-in part of it (e.g. a Settings tab, the Skills page, the dock, an existing app's behavior).",
    content: [
      "Development in BOS is always done by the Claude developer sub-agent. Never write code yourself, and never use the virtual file system (listFiles/readFile/writeFile) to find or change code - the VFS is the user's sandboxed data, not BOS source.",
      "",
      "First decide which use-case applies, then follow the matching reference:",
      "- Modifying BOS itself (built-in apps, Settings pages/tabs, the desktop, API routes, or server logic - editing the BOS source under src/): read references/modifying-bos-features.md.",
      "- Building an app that runs in BOS (a self-contained app installed into BOS and shown in a window, without changing BOS's own code): read references/building-apps.md.",
      "",
      "Shared rules (both use-cases):",
      "1. Do not explore the codebase or VFS yourself and do not try to understand the implementation first - delegate the whole request.",
      "2. Delegate to the developer sub-agent: delegateToSubAgent with agent 'developer' (Claude - required for all coding). For a large or vague request, optionally delegate to the planner sub-agent first and hand its plan to the developer.",
      "3. When the developer reports back, summarize what changed and how to try it; the docs are source files under docs/usage (end users) and docs/dev (developers) and must be updated by the developer as part of the change.",
      "4. If the developer sub-agent or Claude harness is unavailable, tell the user - never fall back to editing code through the VFS or writing it yourself.",
    ].join("\n"),
    references: [
      {
        name: "modifying-bos-features.md",
        content: [
          "Use this when changing BrowserOS's own built-in functionality - a built-in app, a Settings tab/page, the desktop/dock, an API route, or server logic. This edits the BOS source (a Next.js App Router app under src/), not the VFS.",
          "",
          "Delegate the change: call delegateToSubAgent with agent 'developer'. Give a clear, complete description of the desired change plus acceptance criteria (what the user should see or be able to do afterward). The developer has repo-scoped access: it works on a git feature branch, finds the right files, edits them, runs typecheck/lint, and stages the changes. Edits under src/ hot-reload in the dev server; some changes (new dependencies, server/config) need a restart.",
          "",
          "Tell the developer to read docs/dev/ (start at docs/dev/architecture-overview.md - architecture, repo and data/ layout, API routes, extension recipes) and spec/bos.md (requirements) before designing, and to follow BOS conventions: keep the server/client boundary (server-only modules behind /api routes), keep app content text-selectable, work on a feature branch, and update docs/usage + docs/dev (and spec/bos.md if the architecture changes).",
          "",
          "Design choices to prefer: make user-editable values a config namespace (a Settings tab) instead of hardcoding, which also exposes them to the assistant as tools; prefer a standalone installed app over a new built-in app when a self-contained app would do; keep changes focused and reversible; do not touch secrets, package.json, lockfiles, or build config unless explicitly asked.",
          "",
          "Require tests: the developer MUST add or extend Playwright end-to-end tests (and any fixtures they need) under e2e/ that cover the change, and run them (`npm run test:e2e`, or the `e2e` dev command) until green before reporting done. Tests must be deterministic and self-contained (seed their own state); for assistant/chat flows, assert only that the UI mounts/streams, never on the model's exact output.",
          "",
          "After it reports: summarize what changed and how to test it, and ensure the developer updated the relevant pages under docs/usage and docs/dev.",
        ].join("\n"),
      },
      {
        name: "building-apps.md",
        content: [
          "Use this when the user wants a new application inside BOS (a tool/utility shown in a window) - not a change to BOS's own code. The result is a self-contained app installed into BOS and rendered as an iframe.",
          "",
          "1. Clarify the spec: core features, UI, any data persistence, and whether it should call same-origin BOS APIs (e.g. /api/fs for the virtual file system). For a large or vague request, optionally delegate to the planner sub-agent first.",
          "2. Delegate the build to the developer sub-agent (delegateToSubAgent, agent 'developer', contentOnly: true - building an app is a content op, not a BOS-source edit, so it must not spin up a BOS-code candidate). Require: a single self-contained index.html with all CSS and JS inline; no external dependencies, CDNs, or network calls (same-origin BOS API calls are allowed); output ONLY the HTML document starting with <!doctype html>, and do not write files.",
          "3. Extract the HTML from the developer's output; if wrapped in prose or a code fence, keep only the <!doctype html> ... </html> document.",
          "4. Install it with installApp: pass name, the full html, and an appropriate Lucide icon (e.g. Clock, Calculator, ListTodo, Music; omit to auto-pick). installApp writes the app as a self-contained folder into the apps content repo (GitFS - git-versioned, discovered by directory listing, not the VFS), serves it at /apps/<id>, adds its icon to the dock, and opens it.",
          "5. Document it: ensure the new app is described under docs/usage/apps (purpose, features, and how to use it) as part of the developer's work.",
          "",
          "Notes: this installs a standalone app; it does NOT change BOS's own code (for that, use modifying-bos-features.md). If the developer sub-agent or Claude harness is unavailable, tell the user - do not hand-write the app yourself.",
        ].join("\n"),
      },
    ],
  },
  {
    name: "Build Studio",
    description:
      "Drive the spec-kit pipeline to author and refine BOS specifications, then delegate implementation to the Developer.",
    whenToUse:
      "When authoring, refining, planning, analyzing, or implementing a BOS feature through specs — i.e. running any spec-kit step (constitution, specify, clarify, plan, tasks, analyze, implement, converge).",
    pinned: true,
    content: [
      "The Build Studio skill drives the spec-kit pipeline. BOS adopts spec-kit literally: governing principles live in .specify/memory/constitution.md; per-feature artifacts live in specs/<NNN-feature>/ (spec.md, plan.md, tasks.md, ...); blank templates live in .specify/templates/ and the authoritative command prompts in .specify/templates/commands/.",
      "",
      "Pipeline (run the step the user asks for; each builds on the previous):",
      "1. constitution — establish/update project principles (.specify/memory/constitution.md).",
      "2. specify — turn an idea into specs/<NNN-feature>/spec.md.",
      "3. clarify — resolve ambiguities; append a '## Clarifications' section to spec.md.",
      "4. plan — produce plan.md (+ research/data-model/contracts when warranted).",
      "5. tasks — produce tasks.md (an ordered, dependency-marked checklist).",
      "6. analyze — cross-artifact consistency check (report only).",
      "7. implement — delegate to the Developer to build the feature.",
      "8. converge — assess code vs spec; append remaining work / record drift in specs/discrepancies.md.",
      "",
      "How to run any step:",
      "- Load the matching reference (references/<step>.md) and follow it.",
      "- Read the authoritative command prompt and template with read_spec (.specify/templates/commands/<step>.md and .specify/templates/<artifact>-template.md), then write the artifact with write_spec / edit_spec. All your file tools are jailed to specs/ and .specify/.",
      "",
      "Golden rules:",
      "- The spec is the source of truth; never get ahead of an agreed spec.",
      "- You NEVER write BOS source. The `implement` step is ALWAYS delegate_to_developer.",
      "- Keep specs and docs in sync; record drift in specs/discrepancies.md.",
      "- New feature folders are numbered NNN-slug (next = highest existing number + 1).",
    ].join("\n"),
    references: [
      {
        name: "constitution.md",
        content:
          "Step: constitution. Read .specify/templates/commands/constitution.md and .specify/templates/constitution-template.md. Create or update .specify/memory/constitution.md with the project's governing principles, and bump the version + amended date line. This is global, not per-feature.",
      },
      {
        name: "specify.md",
        content:
          "Step: specify. Choose a feature id with the NNN-slug convention (list_specs on 'specs' to find the highest existing number; next = +1). Read .specify/templates/commands/specify.md and .specify/templates/spec-template.md, then write specs/<id>/spec.md following the template: prioritized, independently-testable user stories; functional requirements; measurable success criteria. Mark unknowns with [NEEDS CLARIFICATION].",
      },
      {
        name: "clarify.md",
        content:
          "Step: clarify. Read specs/<id>/spec.md; find ambiguities and [NEEDS CLARIFICATION] markers; ask the user concrete questions. Then append a '## Clarifications' section containing a '### Session <date>' list of Q→A, and update the affected requirements with edit_spec.",
      },
      {
        name: "plan.md",
        content:
          "Step: plan. Read the spec plus .specify/templates/commands/plan.md and .specify/templates/plan-template.md. Write specs/<id>/plan.md: technical context; a Constitution Check against .specify/memory/constitution.md; concrete project structure (real file paths); and design notes. Add research.md / data-model.md / contracts/ only when warranted.",
      },
      {
        name: "tasks.md",
        content:
          "Step: tasks. Read the spec and plan plus .specify/templates/commands/tasks.md and .specify/templates/tasks-template.md. Write specs/<id>/tasks.md: tasks grouped by user story, dependency-ordered, [P] for parallelizable, with exact file paths.",
      },
      {
        name: "analyze.md",
        content:
          "Step: analyze. Read spec + plan + tasks and report cross-artifact inconsistencies and coverage gaps (e.g. requirements with no task, tasks with no requirement, constitution violations). Report only — do not edit artifacts unless asked.",
      },
      {
        name: "implement.md",
        content:
          "Step: implement. Ensure spec.md, plan.md and tasks.md exist. Call delegate_to_developer with a complete task: the feature path (specs/<id>), a summary of the spec and plan, the tasks to execute, and acceptance criteria; instruct the Developer to work on a feature branch, run typecheck/lint, and update docs. You never write code yourself — relay the Developer's result and reflect updated status.",
      },
      {
        name: "converge.md",
        content:
          "Step: converge. Compare the implemented code against spec/plan/tasks (delegate investigation to the Developer if needed). Append any remaining work to tasks.md, and record divergences between code and spec in specs/discrepancies.md.",
      },
    ],
  },
];

// Skills that must exist on EVERY install, including ones upgraded from before
// the skill shipped. Back-filled only when missing (never clobbering edits).
const ADDITIVE_SEED = SEED.filter((s) => s.name === "Build Studio");

let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  const existing = await listSkillIds();
  if (existing.length === 0) {
    for (const s of SEED) await writeSkill({ id: slugify(s.name), createdBy: "seed", ...s });
    return;
  }
  for (const s of ADDITIVE_SEED) {
    if (!existing.includes(slugify(s.name))) await writeSkill({ id: slugify(s.name), createdBy: "seed", ...s });
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
