import "server-only";
import { complete } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { getSkill, saveSkill, type Skill } from "./store";

const PROPOSE_SYSTEM =
  "You decide whether a conversation revealed a GENERALLY reusable skill worth saving for future, unrelated tasks. " +
  'Return ONLY JSON: {"create": boolean, "name": string, "description": string, "whenToUse": string, "content": string}. ' +
  "content must be concise step-by-step instructions. If nothing reusable, return {\"create\": false}.";

/** Propose and save a new skill from a conversation, if warranted. */
export async function proposeSkillFromConversation(transcript: string): Promise<Skill | null> {
  if (!(await hasCredentials())) return null;
  try {
    const text = await complete({ system: PROPOSE_SYSTEM, prompt: transcript });
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { create?: boolean; name?: string; description?: string; whenToUse?: string; content?: string };
    if (!parsed.create || !parsed.name || !parsed.content) return null;
    return await saveSkill({
      name: parsed.name,
      description: parsed.description ?? "",
      whenToUse: parsed.whenToUse,
      content: parsed.content,
      score: 1,
    });
  } catch {
    return null;
  }
}

/** Lightweight positive/negative reinforcement: nudge a skill's score by `delta`
 *  (clamped 0-10) without an LLM rewrite. Used for thumbs-up on a turn that used
 *  the skill — a good response shouldn't trigger a risky rewrite, just raise
 *  confidence. */
export async function nudgeSkillScore(idOrName: string, delta: number): Promise<Skill | null> {
  const skill = await getSkill(idOrName);
  if (!skill) return null;
  const score = Math.max(0, Math.min(10, (skill.score ?? 1) + delta));
  if (score === skill.score) return skill;
  return saveSkill({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    content: skill.content,
    scripts: skill.scripts,
    references: skill.references,
    score,
  });
}

const IMPROVE_SYSTEM =
  "You are a GEPA-style reflective optimizer for agent skills. Given a skill and feedback, produce an improved version. " +
  'Return ONLY JSON: {"content": string, "description": string, "score": number} where score (0-10) is the QUALITY of the resulting skill after your edit — a fair, absolute rating, not merely confidence that it improved. Lower it when the feedback exposes a real weakness you could only partially address; raise it when the skill is now solid. ' +
  "Keep instructions concrete and concise; incorporate the feedback; preserve what already worked.";

/** GEPA-lite: reflectively improve a skill from feedback (user or self-reflection). */
export async function improveSkill(idOrName: string, feedback: string): Promise<Skill | null> {
  if (!(await hasCredentials())) return null;
  const skill = await getSkill(idOrName);
  if (!skill) return null;
  try {
    const prompt = `SKILL "${skill.name}"\nCurrent description: ${skill.description}\nCurrent instructions:\n${skill.content}\n\nFEEDBACK:\n${feedback}`;
    const text = await complete({ system: IMPROVE_SYSTEM, prompt });
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { content?: string; description?: string; score?: number };
    if (!parsed.content) return null;
    // Score is an absolute quality rating and may move in EITHER direction, so a
    // criticism-driven improvement can lower a skill's score (no max() clamp).
    const newScore =
      typeof parsed.score === "number" ? Math.max(0, Math.min(10, parsed.score)) : (skill.score ?? 0);
    return await saveSkill({
      name: skill.name,
      description: parsed.description || skill.description,
      whenToUse: skill.whenToUse,
      content: parsed.content,
      score: newScore,
    });
  } catch {
    return null;
  }
}
