import "server-only";
import { CORE_POLICY } from "./config";
import { getActiveAgentBody } from "./subagents/store";
import { listSkills } from "./skills/store";
import { memorySnapshot } from "./memory/curated";

// Composes the assistant's system instructions: always-on core policy, the
// active agent's personality, the curated memory snapshot (frozen for the
// session), then a skills index (full skill bodies loaded on demand via loadSkill).
export async function composeInstructions(): Promise<string> {
  const [personality, skills, memory] = await Promise.all([getActiveAgentBody(), listSkills(), memorySnapshot()]);
  let out = `${CORE_POLICY}\n\n## Personality\n${personality}`;
  if (memory) out += `\n\n${memory}`;
  if (skills.length > 0) {
    const index = skills
      .map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`)
      .join("\n");
    out += `\n\n## Skills\nYou have a skill library. When a skill is relevant, call loadSkill to read its full instructions, then follow them.\n${index}`;
  }
  return out;
}
