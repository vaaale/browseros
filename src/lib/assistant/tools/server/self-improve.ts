import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { startSelfImprove } from "@/lib/agent/self-improve";
import { runCurator } from "@/lib/agent/skills/curator";
import { improveSkill } from "@/lib/agent/skills/improve";

// Self-improvement + skill maintenance tools (ported from
// SelfImprovementActions.tsx). self_improve runs in the BACKGROUND (fire-and-
// forget) — it analyses this conversation and improves the relevant skill or
// records a durable memory; conversationId comes from ctx (never hallucinated).

export function selfImproveTools(): Record<string, AssistantTool> {
  return {
    self_improve: serverTool(
      "self_improve",
      "Call this when the user is dissatisfied with, or questions, HOW you did a task (a criticism of your APPROACH — e.g. 'why did you do X?', 'why not Y?', 'that's not what I asked for') and it is not neutral curiosity or a one-off whim. Provide an honest, specific reflection: what you did, why the user was dissatisfied, and the better approach. It runs in the BACKGROUND — improving the relevant skill(s) or recording a durable memory. You do NOT need to name the skill; just reflect honestly and keep helping the user.",
      schema({ reflection: p.str("Your honest reflection on the criticism and what the better approach would be.") }, ["reflection"]),
      async (input, ctx) => {
        const reflection = String(input.reflection ?? "").trim();
        if (!reflection) return "Error: self_improve: reflection is required.";
        startSelfImprove({
          agentId: ctx.agentId,
          conversationId: ctx.conversationId,
          trigger: { kind: "reflection", reflection },
        });
        return "Self-improvement started in the background — I'll keep helping you.";
      },
    ),

    skill_curate: serverTool(
      "skill_curate",
      "Run the skill Curator: archives stale, agent-created, unpinned skills (never deletes — archived skills are restorable). Use occasionally to keep the skill library tidy.",
      schema(),
      async () => {
        const res = await runCurator();
        return `Curator reviewed ${res.reviewed} skill(s); archived ${res.archived.length}${res.archived.length ? `: ${res.archived.join(", ")}` : ""}.`;
      },
    ),

    skill_improve: serverTool(
      "skill_improve",
      "Improve a SPECIFIC existing skill from explicit feedback (GEPA-lite reflective optimization). For approach criticism from the user, prefer self_improve, which finds the right skill(s) itself.",
      schema({ skill: p.str("Skill name or id"), feedback: p.str("What to improve / what went wrong or well") }, ["skill", "feedback"]),
      async (input) => {
        const skill = await improveSkill(String(input.skill ?? ""), String(input.feedback ?? ""));
        if (!skill) return `Error: skill_improve: could not improve "${input.skill}" — check the skill id, and that AI credentials are configured.`;
        return `Improved skill "${skill.name}" (score ${skill.score}).`;
      },
    ),
  };
}
