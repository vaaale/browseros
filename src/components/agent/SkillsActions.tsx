"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import type { Skill } from "@/lib/agent/skills/store";

// Skill library access for the assistant: load full skill instructions on
// demand and save new skills it has learned.
export function SkillsActions() {
  useCopilotAction({
    name: "loadSkill",
    description: "Load the full instructions for a skill by name or id (the system prompt lists available skills).",
    parameters: [{ name: "skill", type: "string", description: "Skill name or id", required: true }],
    handler: async ({ skill }) => {
      const res = await fetch(`/api/skills?id=${encodeURIComponent(skill as string)}`).then((r) => r.json());
      const s: Skill | undefined = res.skill;
      return s ? `# ${s.name}\n${s.content}` : `No skill "${skill}".`;
    },
  });

  useCopilotAction({
    name: "saveSkill",
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
