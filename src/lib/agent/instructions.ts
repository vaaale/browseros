import "server-only";
import { CORE_POLICY, DEFAULT_PERSONALITY } from "./config";
import { getActiveAgentId, getSubAgent } from "./subagents/store";
import { listSkills } from "./skills/store";
import { memorySnapshot } from "./memory/curated";
import { filterAllowed } from "./capabilities";

// Composes the assistant's system instructions: always-on core policy, the
// agent's personality, the curated memory snapshot (frozen for the session),
// then a skills index (full skill bodies loaded on demand via loadSkill). The
// skills index is filtered to the agent's allowed skills (011-per-agent-capabilities;
// unset = all). Pass an explicit agentId to compose for an embed's pinned agent
// (012-embeddable-assistant); defaults to the globally active agent.
export async function composeInstructions(agentId?: string): Promise<string> {
  const id = agentId ?? (await getActiveAgentId());
  const [agent, skills, memory] = await Promise.all([getSubAgent(id), listSkills(), memorySnapshot()]);
  const personality = agent?.systemPrompt?.trim() || DEFAULT_PERSONALITY;
  let out = `${CORE_POLICY}\n\n## Personality\n${personality}`;
  if (memory) out += `\n\n${memory}`;
  const allowed = filterAllowed(agent?.skills, skills, (s) => s.id);
  if (allowed.length > 0) {
    const index = allowed
      .map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`)
      .join("\n");
    out += `\n\n## Skills\nYou have a skill library. When a skill is relevant, call loadSkill to read its full instructions, then follow them.\n${index}`;
  }
  return out;
}
