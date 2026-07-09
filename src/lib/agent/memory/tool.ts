import "server-only";
import type { LlmTool } from "@/lib/agent/llm";
import { addTopicEntry, createTopic, getTopic, listTopicSlugs } from "./topics";
import { readMemoryDoc } from "./agent-memory";
import { makeMemorySearchTool } from "./search";

// Agent-scoped memory tools (023-per-agent-memory). Durable knowledge lives in
// per-agent topic shards under /Memories/<agentId>/Topics/. MEMORY.md holds the
// user-preferences summary + an auto-generated index of those topics.
//
//   memory_recall(topic?)  — no arg: return MEMORY.md (preferences + topic index);
//                            with a slug: return that topic file's entries.
//   memory_save(topic, …)  — add a high-signal entry to a topic (created if new).
//   memory_search(query)   — keyword search across topics + episodes.

function formatTopic(slug: string, digest: string, entries: { text: string; timestamp: string }[]): string {
  const head = `## Topic: ${slug}${digest ? `\n> ${digest}` : ""}`;
  if (!entries.length) return `${head}\n_(empty)_`;
  return `${head}\n- ${entries.map((e) => `[${e.timestamp}] ${e.text}`).join("\n- ")}`;
}

async function recall(agentId: string, topic?: string): Promise<string> {
  const slug = (topic ?? "").trim();
  if (slug) {
    const t = await getTopic(agentId, slug);
    if (!t) return `No topic "${slug}". Call memory_recall with no argument to see the index.`;
    return formatTopic(t.slug, t.digest, t.entries);
  }
  const doc = await readMemoryDoc(agentId);
  const prefs = doc.preferences ? `# User preferences\n${doc.preferences}` : "";
  const index = doc.index.length
    ? `# Memory index (call memory_recall with a topic slug to read one)\n${doc.index
        .map((r) => `- ${r.file.replace(/^Topics\//, "").replace(/\.md$/, "")}: ${r.description}`)
        .join("\n")}`
    : "";
  const body = [prefs, index].filter(Boolean).join("\n\n");
  return body || "Memory is empty.";
}

async function save(agentId: string, topic: string, content: string, digest?: string): Promise<string> {
  const slug = (topic ?? "").trim();
  const text = (content ?? "").trim();
  if (!slug) return "Error: topic is required (a short lower-kebab slug for the memory file).";
  if (!text) return "Error: content is required.";
  // Ensure the topic exists with a digest when a new one is being introduced.
  if (digest && digest.trim() && !(await getTopic(agentId, slug))) {
    await createTopic(agentId, slug, digest.trim());
  }
  const r = await addTopicEntry(agentId, slug, text);
  if (!r.success) return `Error: ${r.error}`;
  return `${r.message ?? "Saved."} (topics/${slug} ${r.usage ?? ""})`;
}

/** Build the agent-scoped memory tool bundle for local sub-agents / the review pass. */
export function makeMemoryTools(agentId: string): Record<string, LlmTool> {
  return {
    memory_recall: {
      description:
        "Read this agent's persistent memory. With no argument: returns the user-preferences summary and the index of topic files. With topic='<slug>': returns that topic file's entries. Use memory_search for keyword lookup.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "Optional topic slug to load a single topic file." } },
      },
      execute: async (input) => recall(agentId, input.topic ? String(input.topic) : undefined),
    },
    memory_save: {
      description:
        "Save a durable, high-signal fact into a topic file (survives across sessions; the topic index is injected into future prompts). Pick a stable lower-kebab topic slug (e.g. 'gmail-workflows'). WHEN: the user states a preference/correction or a stable environment/convention/lesson emerges. SKIP: task logs, raw data, easily re-discovered facts. Reusable procedures belong in a SKILL.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Lower-kebab topic slug the entry belongs to." },
          content: { type: "string", description: "The entry text — compact and high-signal." },
          digest: { type: "string", description: "One-line topic description, used only when creating a new topic." },
        },
        required: ["topic", "content"],
      },
      execute: async (input) =>
        save(agentId, String(input.topic ?? ""), String(input.content ?? ""), input.digest ? String(input.digest) : undefined),
    },
    memory_search: makeMemorySearchTool(agentId),
  };
}

// Direct helpers for the /api/memory route (no LLM wrapper).
export const memoryApi = { recall, save, listTopicSlugs };
