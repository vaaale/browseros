// 048 FR-028 — what a phase's SKILL says, for the canvas inspector.
//
// The inspector's job is to answer three questions about a selected phase: what
// does this step do, how does it do it, and how do I change it. For spec-kit
// `instructions` answers all three, because a phase is one command file. For
// BMAD it answered none of them: a phase is performed by a SKILL, so the pane
// reported "this pack declares no prompts" for all ten while `bmad-prd` alone
// carried a prompt, a template, a validation checklist, two references and a
// declared customisation surface.
//
// WHY THIS READS `data/skills/` RATHER THAN THE PACK
//
// That is the copy the agent actually loads. Reading the pack root would show
// the shipped text while the agent ran something else — and a skill the user has
// edited locally is never overwritten by re-seeding, so the two genuinely differ.
// Showing the pack's copy would be describing a skill nobody runs.
//
// WHY `customize.toml` IS SHOWN AND NOT PARSED
//
// BMAD's own documentation: "Every customizable skill ships a `customize.toml`
// in its installed folder. That file is the schema: read it to see what is
// customizable." It is heavily commented and self-describing. Parsing it would
// mean modelling BMAD's merge semantics to say anything useful about a field —
// which 048 FR-004 forbids in terms: BOS supplies the location, the pack owns
// the merge. So BOS shows the schema and routes the WRITE to the pack's own
// mechanism.

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { getMethod } from "./registry";

/** Where a skill lives once seeded — the copy the agent loads. */
const skillDir = (id: string, root?: string) => path.join(root ?? dataDir(), "skills", id);

export interface PhaseSkill {
  id: string;
  /** From the skill's frontmatter. */
  name: string;
  description: string;
  /** The prompt itself — what this step does and how. */
  body: string;
  /** Templates and other assets it works from, by relative path. */
  assets: string[];
  /** Reference documents it loads. */
  references: string[];
  /** The pack's OWN customisation surface, verbatim.
   *
   *  Present ⇒ this skill is customised through the pack's mechanism, and BOS's
   *  overlay editor must not be offered for it: two merges over one file makes
   *  "which version am I running" a question with two answers. */
  customize: { rel: string; content: string } | null;
  /** True when the skill is declared but not installed — reported, never shown
   *  as an empty skill. */
  missing: boolean;
}

/** Frontmatter is `---`-delimited; everything after it is the body. */
function split(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return { meta, body: m[2] };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => !f.startsWith(".")).sort();
  } catch (err) {
    // ENOENT is "this skill ships none", which is ordinary. Anything else is a
    // skill that exists and cannot be read, and reporting it as empty would
    // describe a skill by what BOS failed to see.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readIfPresent(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function readOne(id: string, root?: string): Promise<PhaseSkill> {
  const dir = skillDir(id, root);
  const raw = await readIfPresent(path.join(dir, "SKILL.md"));
  if (raw === null) {
    return { id, name: id, description: "", body: "", assets: [], references: [], customize: null, missing: true };
  }
  const { meta, body } = split(raw);
  const customizeRel = "customize.toml";
  const customize = await readIfPresent(path.join(dir, customizeRel));
  return {
    id,
    name: meta.name || id,
    description: meta.description || "",
    body,
    assets: await listDir(path.join(dir, "assets")),
    references: await listDir(path.join(dir, "references")),
    customize: customize === null ? null : { rel: customizeRel, content: customize },
    missing: false,
  };
}

/** The skills a phase declares, resolved. Empty when the pack declares none —
 *  which is a real answer and not the same as a skill that is missing. */
export async function readPhaseSkills(workflowId: string, phaseId: string, root?: string): Promise<PhaseSkill[]> {
  const d = getMethod(workflowId);
  if (!d) throw new Error(`No workflow "${workflowId}".`);
  const phase = d.phases.find((p) => p.id === phaseId);
  if (!phase) throw new Error(`Workflow "${workflowId}" has no phase "${phaseId}".`);

  const out: PhaseSkill[] = [];
  for (const id of phase.skills ?? []) out.push(await readOne(id, root));
  return out;
}
