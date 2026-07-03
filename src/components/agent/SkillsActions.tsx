"use client";

import { useCopilotAction } from "@/components/agent/gated-action";
import type { Skill } from "@/lib/agent/skills/store";

// Skill library access for the assistant: list skills, load a skill's full
// instructions, read its bundled resource files (progressive disclosure), and
// save new skills it has learned.
export function SkillsActions() {
  useCopilotAction({
    name: "skill_list",
    description: "List available skills (id, name, description, when to use). The system prompt already includes this index; use this to refresh or when it isn't present.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/skills").then((r) => r.json());
      const skills: Skill[] = res.skills ?? [];
      if (skills.length === 0) return "No skills available.";
      return skills.map((s) => `- ${s.id}: ${s.name} — ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`).join("\n");
    },
  });

  useCopilotAction({
    name: "skill_load",
    description:
      "Load the full instructions for a skill by name or id (the system prompt lists available skills). The returned SKILL.md may reference bundled files (references and scripts); open those with skill_read_file, and run scripts with run_command.",
    parameters: [{ name: "skill", type: "string", description: "Skill name or id", required: true }],
    handler: async ({ skill }) => {
      const res = await fetch(`/api/skills?id=${encodeURIComponent(skill as string)}`).then((r) => r.json());
      const s: Skill | undefined = res.skill;
      if (!s) return `No skill "${skill}".`;
      const files: string[] = res.files ?? [];
      const filesNote = files.length > 0 ? `\n\n---\nBundled files (read with skill_read_file):\n${files.map((f) => `- ${f}`).join("\n")}` : "";
      return `# ${s.name}\n${s.content}${filesNote}`;
    },
  });

  useCopilotAction({
    name: "skill_read_file",
    description:
      "Read a bundled file from a skill by relative path — a reference doc or a script listed by skill_load (e.g. 'editing.md', 'scripts/thumbnail.py'). Read-only and scoped to the skill's directory.",
    parameters: [
      { name: "skill", type: "string", description: "Skill name or id", required: true },
      { name: "path", type: "string", description: "Relative path within the skill (e.g. 'references/foo.md' or 'scripts/bar.py')", required: true },
    ],
    handler: async ({ skill, path }) => {
      const res = await fetch(`/api/skills?id=${encodeURIComponent(skill as string)}&file=${encodeURIComponent(path as string)}`).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : (res.content as string);
    },
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
    handler: async ({ name, description, whenToUse, content }) => {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, whenToUse, content }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Saved skill "${res.skill.name}".`;
    },
  });

  return null;
}
