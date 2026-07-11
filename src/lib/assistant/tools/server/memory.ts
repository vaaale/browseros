import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { readMemoryDoc } from "@/lib/agent/memory/agent-memory";
import { addTopicEntry, createTopic, getTopic } from "@/lib/agent/memory/topics";
import { memorySearch } from "@/lib/agent/memory/search";

// Per-agent memory tools (023-per-agent-memory), ported from MemoryActions.tsx.
// The agent id comes from the run context (the old client passed its pinned
// agentId as a query param).

export function memoryTools(): Record<string, AssistantTool> {
  return {
    memory_save: serverTool(
      "memory_save",
      "Save a durable, high-signal fact into one of your memory TOPIC files (survives across sessions; the topic index is injected into future prompts). Pick a stable lower-kebab topic slug (e.g. 'gmail-workflows'). Save proactively on preferences, corrections, and stable facts — the best memory stops the user repeating themselves. Skip task logs, raw data, and easily re-discovered facts; reusable procedures belong in a skill.",
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
      "Read your persistent memory. Without arguments: returns your user-preferences summary and the index of topic files. Pass topic='<slug>' to load a specific topic file's entries. Use memory_search for keyword lookup across topics + episodes.",
      schema({ topic: p.str("Optional topic slug to load a single topic file.") }),
      async (input, ctx) => {
        const slug = String(input.topic ?? "").trim();
        if (slug) {
          const topic = await getTopic(ctx.agentId, slug);
          if (!topic) {
            return `No topic "${slug}". Call memory_recall with no argument to see the index, or use memory_search with a keyword query.`;
          }
          if (!topic.entries.length) return `Topic "${slug}" is empty.`;
          const digest = topic.digest ? `> ${topic.digest}\n` : "";
          return `## Topic: ${topic.slug}\n${digest}\n- ${topic.entries.map((e) => `[${e.timestamp}] ${e.text}`).join("\n- ")}`;
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

    memory_search: serverTool(
      "memory_search",
      "Search your long-term memory (topic shards + recent episodes) for entries matching a query. Case-insensitive substring/word match; returns provenance (VFS path + in-file anchor), matched content, and a relevance score.",
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
        return results.map((r) => `- ${r.source} (score ${r.score})\n  ${r.content}`).join("\n");
      },
    ),
  };
}
