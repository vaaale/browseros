import "server-only";
import { CORE_POLICY } from "./config";
import { getActiveProfileBody } from "./profiles/store";
import { listSkills } from "./skills/store";

// Composes the assistant's system instructions: always-on core policy, then the
// active personality profile, then a skills index (full skill bodies loaded on
// demand via the loadSkill tool).
export async function composeInstructions(): Promise<string> {
  const [profile, skills] = await Promise.all([getActiveProfileBody(), listSkills()]);
  let out = `${CORE_POLICY}\n\n## Personality\n${profile}`;
  if (skills.length > 0) {
    const index = skills
      .map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`)
      .join("\n");
    out += `\n\n## Skills\nYou have a skill library. When a skill is relevant, call loadSkill to read its full instructions, then follow them.\n${index}`;
  }
  return out;
}
