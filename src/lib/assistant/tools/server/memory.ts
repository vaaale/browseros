import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { readMemoryDoc } from "@/lib/agent/memory/agent-memory";
import { addTopicEntry, createTopic, entryStateAt, getTopic, removeTopicEntry, replaceTopicEntry, type TopicEntry } from "@/lib/agent/memory/topics";
import { memorySearch } from "@/lib/agent/memory/search";

// Per-agent memory tools (023-per-agent-memory), ported from MemoryActions.tsx.
// Self-edit (memory_replace/memory_remove) + lifecycle labeling added by
// 028-memory-curation-retrieval. The agent id comes from the run context (the
// old client passed its pinned agentId as a query param).

function formatEntry(e: TopicEntry, asOf?: string): string {
  const state = asOf ? entryStateAt(e, asOf) : (e.state ?? "active");
  const label = state === "superseded" ? " (not current — superseded)" : state === "not-yet-created" ? " (not yet recorded as of this date)" : "";
  return `[${e.timestamp}] ${e.text}${label}`;
}

export function memoryTools(): Record<string, AssistantTool> {
  return {
    memory_save: serverTool(
      "memory_save",
      "Save a durable, high-signal fact into one of your memory TOPIC files (survives across sessions; the topic index is injected into future prompts). Pick a stable lower-kebab topic slug (e.g. 'gmail-workflows'). Save proactively on preferences, corrections, and stable facts — the best memory stops the user repeating themselves. Skip task logs, raw data, and easily re-discovered facts; reusable procedures belong in a skill. Saving to a full topic still succeeds — it flags the topic for background tidying rather than failing.",
      schema(
        {
          topic: p.str("Lower-kebab topic slug the entry belongs to."),
          content: p.str("The entry text — compact and high-signal."),
          digest: p.str("One-line topic description, used only when creating a new topic."),
        },
        ["topic", "content"],
      ),
      async (input, ctx) => {
        const slug = String(input.topic ?? "").trim();
        const text = String(input.content ?? "").trim();
        if (!slug || !text) return "Provide both a topic slug and content.";
        // Create with a digest first if a new topic is being introduced
        // (best-effort: a failure here just means the topic gets no digest).
        const digest = String(input.digest ?? "").trim();
        if (digest) await createTopic(ctx.agentId, slug, digest).catch(() => undefined);
        const res = await addTopicEntry(ctx.agentId, slug, text);
        if (res.error) return `Error: ${res.error}`;
        return `${res.message ?? "Saved."} (topics/${slug} ${res.usage ?? ""})`;
      },
    ),

    memory_recall: serverTool(
      "memory_recall",
      "Read your persistent memory. Without arguments: returns your user-preferences summary and the index of topic files. Pass topic='<slug>' to load a specific topic file's entries — active entries are current, superseded entries are labeled 'not current'. Pass asOf='<yyyy-mm-dd>' to see entry state as of a historical date instead of now. Use memory_search for keyword/semantic lookup across topics + episodes.",
      schema({
        topic: p.str("Optional topic slug to load a single topic file."),
        asOf: p.str("Optional yyyy-mm-dd — return entry state as of this date instead of current."),
      }),
      async (input, ctx) => {
        const slug = String(input.topic ?? "").trim();
        const asOf = String(input.asOf ?? "").trim() || undefined;
        if (slug) {
          const topic = await getTopic(ctx.agentId, slug);
          if (!topic) {
            return `No topic "${slug}". Call memory_recall with no argument to see the index, or use memory_search with a keyword query.`;
          }
          if (!topic.entries.length) return `Topic "${slug}" is empty.`;
          const digest = topic.digest ? `> ${topic.digest}\n` : "";
          return `## Topic: ${topic.slug}\n${digest}\n- ${topic.entries.map((e) => formatEntry(e, asOf)).join("\n- ")}`;
        }
        const doc = await readMemoryDoc(ctx.agentId);
        const preferences = String(doc.preferences ?? "").trim();
        const index = doc.index ?? [];
        if (!preferences && index.length === 0) return "Memory is empty.";
        const prefBlock = preferences ? `# User preferences\n${preferences}` : "";
        const indexBlock = index.length
          ? `# Topics (call memory_recall with a slug to read one)\n${index
              .map((r) => `- ${r.file.replace(/^Topics\//, "").replace(/\.md$/, "")}: ${r.description}`)
              .join("\n")}`
          : "";
        return [prefBlock, indexBlock].filter(Boolean).join("\n\n");
      },
    ),

    memory_replace: serverTool(
      "memory_replace",
      "Update an existing topic entry's text in place — use this to correct or refresh a memory instead of appending a duplicate. Identify the entry by its id (from memory_recall/memory_search) or a unique substring of its current text. If the new text duplicates another entry already in the topic, the old entry is dropped and the existing duplicate is kept. Unknown entry → a clear error, no change.",
      schema(
        {
          topic: p.str("Topic slug."),
          entryIdOrText: p.str("The entry's id, or a unique substring of its current text."),
          content: p.str("The entry's new text."),
        },
        ["topic", "entryIdOrText", "content"],
      ),
      async (input, ctx) => {
        const slug = String(input.topic ?? "").trim();
        const key = String(input.entryIdOrText ?? "").trim();
        const text = String(input.content ?? "").trim();
        if (!slug || !key || !text) return "Provide topic, entryIdOrText, and content.";
        const res = await replaceTopicEntry(ctx.agentId, slug, key, text);
        if (!res.success) return `Error: ${res.error}`;
        return `${res.message ?? "Replaced."} (topics/${slug} ${res.usage ?? ""})`;
      },
    ),

    memory_remove: serverTool(
      "memory_remove",
      "Delete an entry from a topic — use this to tidy a topic instead of leaving stale entries. Identify the entry by its id (from memory_recall/memory_search) or a unique substring of its text. Unknown entry → a clear error, no change.",
      schema(
        {
          topic: p.str("Topic slug."),
          entryIdOrText: p.str("The entry's id, or a unique substring of its text."),
        },
        ["topic", "entryIdOrText"],
      ),
      async (input, ctx) => {
        const slug = String(input.topic ?? "").trim();
        const key = String(input.entryIdOrText ?? "").trim();
        if (!slug || !key) return "Provide topic and entryIdOrText.";
        const res = await removeTopicEntry(ctx.agentId, slug, key);
        if (!res.success) return `Error: ${res.error}`;
        return `${res.message ?? "Removed."} (topics/${slug} ${res.usage ?? ""})`;
      },
    ),

    memory_search: serverTool(
      "memory_search",
      "Search your long-term memory (topic shards + recent episodes) for entries matching a query, ranked by a fused dense (semantic) + sparse (keyword) + recency + importance score. Returns provenance (VFS path + in-file anchor), matched content, current/superseded state, and a relevance score. Degrades to keyword + recency + importance when the provider can't serve embeddings.",
      schema(
        {
          query: p.str("Free-text query."),
          maxResults: p.num("Cap on results (default 10)."),
        },
        ["query"],
      ),
      async (input, ctx) => {
        const query = String(input.query ?? "").trim();
        if (!query) return "Provide a query.";
        const max = typeof input.maxResults === "number" && input.maxResults > 0 ? input.maxResults : 10;
        const results = await memorySearch(ctx.agentId, query, max);
        if (!results.length) return "No matches.";
        return results
          .map((r) => `- ${r.source} (score ${r.score.toFixed(3)}${r.state === "superseded" ? ", not current — superseded" : ""})\n  ${r.content}`)
          .join("\n");
      },
    ),
  };
}
