"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import type { Skill } from "@/lib/agent/skills/store";
import { fetchToolJson, runToolHandler } from "@/lib/agent/tool-kernel";

// Skill library access for the assistant: list skills, load a skill's full
// instructions, read its bundled resource files (progressive disclosure), and
// save new skills it has learned.

/** GET /api/skills with the given query string; kernel-safe (never throws). */
const getSkills = (tool: string, qs: string, signal: AbortSignal) =>
  fetchToolJson(tool, `/api/skills${qs}`, { signal });

export function SkillsActions() {
  useCopilotAction({
    name: "skill_list",
    description: "List available skills (id, name, description, when to use). The system prompt already includes this index; use this to refresh or when it isn't present.",
    parameters: [],
    handler: () =>
      runToolHandler("skill_list", async ({ signal }) => {
        const out = await getSkills("skill_list", "", signal);
        if (!out.ok) return out.error;
        const skills = ((out.data as { skills?: Skill[] }).skills ?? []) as Skill[];
        if (skills.length === 0) return "No skills available.";
        return skills.map((s) => `- ${s.id}: ${s.name} — ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`).join("\n");
      }),
  });

  useCopilotAction({
    name: "skill_load",
    description:
      "Load the full instructions for a skill by name or id (the system prompt lists available skills). The returned SKILL.md may reference bundled files (references and scripts); open those with skill_read_file, and run scripts with run_command.",
    parameters: [{ name: "skill", type: "string", description: "Skill name or id", required: true }],
    handler: ({ skill }) =>
      runToolHandler("skill_load", async ({ signal }) => {
        const out = await getSkills("skill_load", `?id=${encodeURIComponent(skill as string)}`, signal);
        if (!out.ok) return out.error;
        const res = out.data as { skill?: Skill; files?: string[] };
        const s = res.skill;
        if (!s) return `No skill "${skill}".`;
        const files: string[] = res.files ?? [];
        const filesNote = files.length > 0 ? `\n\n---\nBundled files (read with skill_read_file):\n${files.map((f) => `- ${f}`).join("\n")}` : "";
        return `# ${s.name}\n${s.content}${filesNote}`;
      }),
  });

  useCopilotAction({
    name: "skill_read_file",
    description:
      "Read a bundled file from a skill by relative path — a reference doc or a script listed by skill_load (e.g. 'editing.md', 'scripts/thumbnail.py'). Read-only and scoped to the skill's directory.",
    parameters: [
      { name: "skill", type: "string", description: "Skill name or id", required: true },
      { name: "path", type: "string", description: "Relative path within the skill (e.g. 'references/foo.md' or 'scripts/bar.py')", required: true },
    ],
    handler: ({ skill, path }) =>
      runToolHandler("skill_read_file", async ({ signal }) => {
        const out = await getSkills(
          "skill_read_file",
          `?id=${encodeURIComponent(skill as string)}&file=${encodeURIComponent(path as string)}`,
          signal,
        );
        if (!out.ok) return out.error;
        const res = out.data as { error?: string; content?: string };
        return res.error ? `Error: ${res.error}` : (res.content as string);
      }),
  });

  useCopilotAction({
    name: "skill_save",
    description:
      "Save a reusable skill (a named, step-by-step procedure) to the library for future sessions. Create one when you discover a generally useful approach.",
    parameters: [
      { name: "name", type: "string", description: "Skill name", required: true },
      { name: "description", type: "string", description: "One-line summary", required: true },
      { name: "whenToUse", type: "string", description: "When this skill applies", required: false },
      { name: "content", type: "string", description: "Step-by-step instructions", required: true },
    ],
    handler: ({ name, description, whenToUse, content }) =>
      runToolHandler("skill_save", async ({ signal }) => {
        const out = await fetchToolJson("skill_save", "/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description, whenToUse, content }),
          signal,
        });
        if (!out.ok) return out.error;
        const res = out.data as { error?: string; skill: Skill };
        return res.error ? `Error: ${res.error}` : `Saved skill "${res.skill.name}".`;
      }),
  });

  return null;
}
