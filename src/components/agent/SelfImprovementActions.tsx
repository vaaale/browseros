"use client";

import { useCopilotAction } from "@copilotkit/react-core";

// Self-improvement: reflect after a task (save memories + auto-create a skill),
// and improve an existing skill from feedback (GEPA-lite).
export function SelfImprovementActions() {
  useCopilotAction({
    name: "reflectAndLearn",
    description:
      "Call this after completing a task. Provide a short transcript/summary of the task and outcome. It records durable memories and, if the approach is reusable, saves a new skill.",
    parameters: [{ name: "transcript", type: "string", description: "Summary of the task, what was done, and the outcome", required: true }],
    handler: async ({ transcript }) => {
      const res = await fetch("/api/assistant/reflect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      return `Reflected: ${res.memories?.length ?? 0} memory(ies)${res.skill ? `, new skill "${res.skill.name}"` : ""}.`;
    },
  });

  useCopilotAction({
    name: "improveSkill",
    description: "Improve an existing skill based on feedback (from the user or your own reflection). GEPA-lite reflective optimization.",
    parameters: [
      { name: "skill", type: "string", description: "Skill name or id", required: true },
      { name: "feedback", type: "string", description: "What to improve / what went wrong or well", required: true },
    ],
    handler: async ({ skill, feedback }) => {
      const res = await fetch("/api/skills/improve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill, feedback }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Improved skill "${res.skill.name}" (score ${res.skill.score}).`;
    },
  });

  return null;
}
