"use client";

import { useCopilotAction } from "@copilotkit/react-core";

// Self-improvement: run the review after a task (updates memory + skills via a
// restricted pass), improve a skill from feedback (GEPA), and run the Curator.
export function SelfImprovementActions() {
  useCopilotAction({
    name: "skill_reflect",
    description:
      "Call this after completing a non-trivial task. Provide a transcript/summary of the task and outcome. Runs the self-improvement review — a separate pass that may update persistent memory and patch/create skills based on what was learned.",
    parameters: [{ name: "transcript", type: "string", description: "Summary of the task, what was done, corrections received, and the outcome", required: true }],
    handler: async ({ transcript }) => {
      const res = await fetch("/api/assistant/reflect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      return res.ran ? `Review (${res.steps} step(s)): ${res.summary}` : `Review skipped: ${res.summary}`;
    },
  });

  useCopilotAction({
    name: "skill_curate",
    description:
      "Run the skill Curator: archives stale, agent-created, unpinned skills (never deletes — archived skills are restorable). Use occasionally to keep the skill library tidy.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/skills/curator", { method: "POST" }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      return `Curator reviewed ${res.reviewed} skill(s); archived ${res.archived?.length ?? 0}${res.archived?.length ? `: ${res.archived.join(", ")}` : ""}.`;
    },
  });

  useCopilotAction({
    name: "skill_improve",
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
