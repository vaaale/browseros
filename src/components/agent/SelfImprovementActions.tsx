"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

// Self-improvement actions. `self_improve` is the primary path: the agent calls
// it (with an honest reflection) when the user criticizes HOW a task was done;
// the conversationId is injected here so the analyzer works from the real
// conversation and can't be hallucinated. `skill_curate` / `skill_improve`
// remain as explicit manual tools.
export function SelfImprovementActions({
  agentId = DEFAULT_AGENT_ID,
  conversationId,
}: {
  agentId?: string;
  conversationId?: string;
}) {
  useCopilotAction({
    name: "self_improve",
    description:
      "Call this when the user is dissatisfied with, or questions, HOW you did a task (a criticism of your APPROACH — e.g. 'why did you do X?', 'why not Y?', 'that's not what I asked for', 'you should have…') and it is not neutral curiosity or a one-off whim. Provide an honest, specific reflection: what you did, why the user was dissatisfied, and the better approach. It runs in the BACKGROUND — analyzing this conversation and improving the relevant skill(s) or recording a durable memory item. You do NOT need to name the skill; just reflect honestly and keep helping the user.",
    parameters: [
      { name: "reflection", type: "string", description: "Your honest reflection on the criticism and what the better approach would be.", required: true },
    ],
    handler: async ({ reflection }) => {
      if (!conversationId) return "Self-improvement unavailable: no active conversation.";
      const res = await fetch("/api/assistant/self-improve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, conversationId, reflection }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      return "Self-improvement started in the background — I'll keep helping you.";
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
    description: "Improve a SPECIFIC existing skill from explicit feedback (GEPA-lite reflective optimization). For approach criticism from the user, prefer self_improve, which finds the right skill(s) itself.",
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
