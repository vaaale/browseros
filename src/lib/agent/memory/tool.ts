import "server-only";
import type { LlmTool } from "@/lib/agent/llm";
import { addTopicEntry, createTopic, entryStateAt, getTopic, listTopicSlugs, removeTopicEntry, replaceTopicEntry, type TopicEntry } from "./topics";
import { readMemoryDoc } from "./agent-memory";
import { makeMemorySearchTool } from "./search";

// Agent-scoped memory tools (023-per-agent-memory; self-edit + lifecycle added
// by 028-memory-curation-retrieval). Durable knowledge lives in per-agent topic
// shards under /Memories/<agentId>/Topics/. MEMORY.md holds the
// user-preferences summary + an auto-generated index of those topics.
//
//   memory_recall(topic?, asOf?) — no arg: return MEMORY.md (preferences + topic
//                            index); with a slug: return that topic file's
//                            entries (superseded entries labeled "not current";
//                            asOf re-derives state as of a given date).
//   memory_save(topic, …)  — add a high-signal entry to a topic (created if new).
//   memory_replace(…)      — update an existing entry's text in place.
//   memory_remove(…)       — delete an entry.
//   memory_search(query)   — hybrid (dense+sparse) ranked search across topics + episodes.

function formatEntry(e: TopicEntry, asOf?: string): string {
  const state = asOf ? entryStateAt(e, asOf) : (e.state ?? "active");
  const label = state === "superseded" ? " (not current — superseded)" : state === "not-yet-created" ? " (not yet recorded as of this date)" : "";
  return `[${e.timestamp}] ${e.text}${label}`;
}

function formatTopic(slug: string, digest: string, entries: TopicEntry[], asOf?: string): string {
  const head = `## Topic: ${slug}${digest ? `\n> ${digest}` : ""}`;
  if (!entries.length) return `${head}\n_(empty)_`;
  return `${head}\n- ${entries.map((e) => formatEntry(e, asOf)).join("\n- ")}`;
}

async function recall(agentId: string, topic?: string, asOf?: string): Promise<string> {
  const slug = (topic ?? "").trim();
  if (slug) {
    const t = await getTopic(agentId, slug);
    if (!t) return `No topic "${slug}". Call memory_recall with no argument to see the index.`;
    return formatTopic(t.slug, t.digest, t.entries, asOf);
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

async function replace(agentId: string, topic: string, entryIdOrText: string, content: string): Promise<string> {
  const slug = (topic ?? "").trim();
  const key = (entryIdOrText ?? "").trim();
  const text = (content ?? "").trim();
  if (!slug || !key || !text) return "Error: topic, entryIdOrText, and content are required.";
  const r = await replaceTopicEntry(agentId, slug, key, text);
  if (!r.success) return `Error: ${r.error}`;
  return `${r.message ?? "Replaced."} (topics/${slug} ${r.usage ?? ""})`;
}

async function remove(agentId: string, topic: string, entryIdOrText: string): Promise<string> {
  const slug = (topic ?? "").trim();
  const key = (entryIdOrText ?? "").trim();
  if (!slug || !key) return "Error: topic and entryIdOrText are required.";
  const r = await removeTopicEntry(agentId, slug, key);
  if (!r.success) return `Error: ${r.error}`;
  return `${r.message ?? "Removed."} (topics/${slug} ${r.usage ?? ""})`;
}

/** Build the agent-scoped memory tool bundle for local sub-agents / the review pass. */
export function makeMemoryTools(agentId: string): Record<string, LlmTool> {
  return {
    memory_recall: {
      description:
        "Read this agent's persistent memory. With no argument: returns the user-preferences summary and the index of topic files. With topic='<slug>': returns that topic file's entries — active entries are current, superseded entries are labeled 'not current'. Pass asOf='<yyyy-mm-dd>' to see entry state as of a historical date instead of now. Use memory_search for keyword/semantic lookup.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Optional topic slug to load a single topic file." },
          asOf: { type: "string", description: "Optional yyyy-mm-dd — return entry state as of this date instead of current." },
        },
      },
      execute: async (input) => recall(agentId, input.topic ? String(input.topic) : undefined, input.asOf ? String(input.asOf) : undefined),
    },
    memory_save: {
      description:
        "Save a durable, high-signal fact into a topic file (survives across sessions; the topic index is injected into future prompts). Pick a stable lower-kebab topic slug (e.g. 'gmail-workflows'). WHEN: the user states a preference/correction or a stable environment/convention/lesson emerges. SKIP: task logs, raw data, easily re-discovered facts. Reusable procedures belong in a SKILL. Saving to a full topic still succeeds — it flags the topic for background tidying rather than failing.",
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
    memory_replace: {
      description:
        "Update an existing topic entry's text in place. Identify the entry by its id (from memory_recall/memory_search) or a unique substring of its current text. If the new text duplicates another entry already in the topic, the old entry is dropped and the existing duplicate is kept (no duplicate remains). Unknown entry → a clear error, no change.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic slug." },
          entryIdOrText: { type: "string", description: "The entry's id, or a unique substring of its current text." },
          content: { type: "string", description: "The entry's new text." },
        },
        required: ["topic", "entryIdOrText", "content"],
      },
      execute: async (input) =>
        replace(agentId, String(input.topic ?? ""), String(input.entryIdOrText ?? ""), String(input.content ?? "")),
    },
    memory_remove: {
      description:
        "Delete an entry from a topic. Identify the entry by its id (from memory_recall/memory_search) or a unique substring of its text. Unknown entry → a clear error, no change.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic slug." },
          entryIdOrText: { type: "string", description: "The entry's id, or a unique substring of its text." },
        },
        required: ["topic", "entryIdOrText"],
      },
      execute: async (input) => remove(agentId, String(input.topic ?? ""), String(input.entryIdOrText ?? "")),
    },
    memory_search: makeMemorySearchTool(agentId),
  };
}

// Direct helpers for the /api/memory route (no LLM wrapper).
export const memoryApi = { recall, save, replace, remove, listTopicSlugs };
