import "server-only";
import { complete } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { addMemory } from "./store";
import type { Memory, MemoryType } from "./types";
import type { SubAgentRunResult } from "@/lib/agent/subagents/types";

/**
 * Heuristic, always-available reflection: record the outcome of a delegation so
 * the memory grows from activity even without an LLM. This is the backbone of
 * the self-improving loop.
 */
export async function recordDelegation(result: SubAgentRunResult): Promise<Memory> {
  const toolNames = result.toolCalls.map((t) => t.tool);
  const content = result.error
    ? `Delegating "${result.task}" to ${result.agent} failed: ${result.error}`
    : `Delegated "${result.task}" to ${result.agent}; completed in ${result.steps} step(s)` +
      (toolNames.length ? ` using ${[...new Set(toolNames)].join(", ")}.` : ".");
  return addMemory({
    type: result.error ? "lesson" : "procedure",
    content,
    tags: [result.agent.toLowerCase(), ...(result.error ? ["failure"] : ["success"])],
  });
}

const REFLECT_SYSTEM =
  "You extract durable, reusable memories from an interaction. Return ONLY a JSON array of objects " +
  '{ "type": "lesson"|"fact"|"preference"|"procedure", "content": string, "tags": string[] }. ' +
  "Keep each content to one sentence. Capture only what will help in future, unrelated sessions. " +
  "If nothing is worth remembering, return [].";

/**
 * LLM-based reflection: extract durable lessons from an interaction transcript.
 * No-ops gracefully when no provider credentials are configured.
 */
export async function reflect(transcript: string): Promise<Memory[]> {
  if (!(await hasCredentials())) return [];
  try {
    const text = await complete({ system: REFLECT_SYSTEM, prompt: transcript });
    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    const items = JSON.parse(json) as { type: MemoryType; content: string; tags?: string[] }[];
    const stored: Memory[] = [];
    for (const item of items) {
      if (item?.content) stored.push(await addMemory({ type: item.type ?? "lesson", content: item.content, tags: item.tags }));
    }
    return stored;
  } catch {
    return [];
  }
}
