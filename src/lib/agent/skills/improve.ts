import "server-only";
import { complete } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { getSkill, saveSkill, type Skill } from "./store";
import { reflect } from "@/lib/agent/memory/reflect";
import type { Memory } from "@/lib/agent/memory/types";

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

const IMPROVE_SYSTEM =
  "You are a GEPA-style reflective optimizer for agent skills. Given a skill and feedback, produce an improved version. " +
  'Return ONLY JSON: {"content": string, "description": string, "score": number} where score (0-10) is your confidence the new version is better. ' +
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
    const newScore = Math.max(skill.score ?? 0, typeof parsed.score === "number" ? parsed.score : (skill.score ?? 0));
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

/** Post-task reflection: extract durable memories and propose a skill if useful. */
export async function reflectAndLearn(transcript: string): Promise<{ memories: Memory[]; skill: Skill | null }> {
  const [memories, skill] = await Promise.all([reflect(transcript), proposeSkillFromConversation(transcript)]);
  return { memories, skill };
}
