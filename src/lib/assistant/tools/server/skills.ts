import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { listSkills, getSkill, saveSkill, patchSkill, readSkillFile, listSkillFiles } from "@/lib/agent/skills/store";
import { touchSkill } from "@/lib/agent/skills/usage";
import { logger } from "@/lib/logging";

// Skill library tools, ported from SkillsActions.tsx: list skills, load a
// skill's full instructions, read its bundled resource files (progressive
// disclosure), and save new skills the assistant has learned.

export function skillsTools(): Record<string, AssistantTool> {
  return {
    skill_list: serverTool(
      "skill_list",
      "List available skills (id, name, description, when to use). The system prompt already includes this index; use this to refresh or when it isn't present.",
      schema(),
      async () => {
        const skills = await listSkills();
        if (skills.length === 0) return "No skills available.";
        return skills
          .map((s) => `- ${s.id}: ${s.name} — ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`)
          .join("\n");
      },
    ),

    skill_load: serverTool(
      "skill_load",
      "Load the full instructions for a skill by name or id (the system prompt lists available skills). The returned SKILL.md may reference bundled files (references and scripts); open those with skill_read_file, and run scripts with run_command.",
      schema({ skill: p.str("Skill name or id") }, ["skill"]),
      async (input) => {
        const id = String(input.skill ?? "");
        const s = await getSkill(id);
        if (!s) return `No skill "${id}".`;
        const files = await listSkillFiles(id).catch(() => [] as string[]);
        const filesNote = files.length > 0
          ? `\n\n---\nBundled files (read with skill_read_file):\n${files.map((f) => `- ${f}`).join("\n")}`
          : "";
        return `# ${s.name}\n${s.content}${filesNote}`;
      },
    ),

    skill_read_file: serverTool(
      "skill_read_file",
      "Read a bundled file from a skill by relative path — a reference doc or a script listed by skill_load (e.g. 'editing.md', 'scripts/thumbnail.py'). Read-only and scoped to the skill's directory.",
      schema(
        {
          skill: p.str("Skill name or id"),
          path: p.str("Relative path within the skill (e.g. 'references/foo.md' or 'scripts/bar.py')"),
        },
        ["skill", "path"],
      ),
      async (input) => readSkillFile(String(input.skill ?? ""), String(input.path ?? "")),
    ),

    skill_save: serverTool(
      "skill_save",
      "Save a reusable skill (a named, step-by-step procedure) to the library for future sessions. Create one when you discover a generally useful approach.",
      schema(
        {
          name: p.str("Skill name"),
          description: p.str("One-line summary"),
          whenToUse: p.str("When this skill applies"),
          content: p.str("Step-by-step instructions"),
        },
        ["name", "description", "content"],
      ),
      async (input) => {
        const name = String(input.name ?? "").trim();
        const content = String(input.content ?? "");
        if (!name || !content) return "Error: skill_save: name and content are required — provide both and retry.";
        const skill = await saveSkill({
          name,
          description: String(input.description ?? ""),
          content,
          whenToUse: input.whenToUse ? String(input.whenToUse) : undefined,
        });
        logger().info("skills", "skill created", { id: skill.id, name: skill.name });
        return `Saved skill "${skill.name}".`;
      },
    ),

    skill_patch: serverTool(
      "skill_patch",
      "Make a contained edit to an EXISTING skill's instructions — replaces the first occurrence of `find` with `replace` in its content. Use this instead of skill_save when only part of a skill needs correcting (e.g. after the user points out a mistake in it). `find` must be an exact substring copied verbatim from the skill's content (load it first with skill_load if you don't already have it verbatim).",
      schema(
        {
          skill: p.str("Skill name or id"),
          find: p.str("Exact substring to replace (copy verbatim from the skill's content)"),
          replace: p.str("Replacement text"),
        },
        ["skill", "find", "replace"],
      ),
      async (input) => {
        const id = String(input.skill ?? "");
        const find = String(input.find ?? "");
        const replace = String(input.replace ?? "");
        const r = await patchSkill(id, find, replace);
        if ("error" in r) return `Error: ${r.error}`;
        await touchSkill(r.id, "patch");
        logger().info("skills", "skill patched", { id: r.id, name: r.name });
        return `Patched "${r.name}".`;
      },
    ),
  };
}
