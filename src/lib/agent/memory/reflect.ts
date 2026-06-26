import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL } from "@/lib/agent/config";
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

let client: Anthropic | null = null;

/**
 * LLM-based reflection: extract durable lessons from an interaction transcript.
 * No-ops gracefully when no API key is configured.
 */
export async function reflect(transcript: string): Promise<Memory[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  try {
    client ??= new Anthropic();
    const res = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: REFLECT_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: transcript }],
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
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
