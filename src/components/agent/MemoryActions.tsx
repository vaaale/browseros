"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

interface MemoryFetchResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

async function fetchMemoryJson(url: string, init?: RequestInit): Promise<MemoryFetchResult> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text.slice(0, 500) };
    }
  }
  return { ok: res.ok, status: res.status, data };
}

function memoryError(result: MemoryFetchResult): string {
  const msg = typeof result.data.error === "string" && result.data.error.trim()
    ? result.data.error.trim()
    : `HTTP ${result.status}`;
  return `Error: ${msg}`;
}

// Per-agent memory actions (023-per-agent-memory). Durable knowledge lives in
// this agent's topic files under /Memories/<agentId>/Topics/; the user-preferences
// summary + topic index (MEMORY.md) is injected into the system prompt at session
// start. These actions let the assistant read/write its own memory.
export function MemoryActions({ agentId = DEFAULT_AGENT_ID }: { agentId?: string }) {
  const q = `?agent=${encodeURIComponent(agentId)}`;

  useCopilotAction({
    name: "memory_save",
    description:
      "Save a durable, high-signal fact into one of your memory TOPIC files (survives across sessions; the topic index is injected into future prompts). Pick a stable lower-kebab topic slug (e.g. 'gmail-workflows'). Save proactively on preferences, corrections, and stable facts — the best memory stops the user repeating themselves. Skip task logs, raw data, and easily re-discovered facts; reusable procedures belong in a skill.",
    parameters: [
      { name: "topic", type: "string", description: "Lower-kebab topic slug the entry belongs to.", required: true },
      { name: "content", type: "string", description: "The entry text — compact and high-signal.", required: true },
      { name: "digest", type: "string", description: "One-line topic description, used only when creating a new topic.", required: false },
    ],
    handler: async ({ topic, content, digest }) => {
      const slug = String(topic ?? "").trim();
      const text = String(content ?? "").trim();
      if (!slug || !text) return "Provide both a topic slug and content.";
      // Create with a digest first if a new topic is being introduced.
      if (digest && String(digest).trim()) {
        await fetch(`/api/memory${q}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "topic", topic: slug, action: "create", content: String(digest).trim() }),
        }).catch(() => undefined);
      }
      const result = await fetchMemoryJson(`/api/memory${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "topic", topic: slug, action: "add", content: text }),
      });
      const res = result.data;
      if (!result.ok) return memoryError(result);
      if (res.error) return `Error: ${res.error}`;
      return `${res.message ?? "Saved."} (topics/${slug} ${res.usage ?? ""})`;
    },
  });

  useCopilotAction({
    name: "memory_recall",
    description:
      "Read your persistent memory. Without arguments: returns your user-preferences summary and the index of topic files. Pass topic='<slug>' to load a specific topic file's entries. Use memory_search for keyword lookup across topics + episodes.",
    parameters: [
      { name: "topic", type: "string", description: "Optional topic slug to load a single topic file.", required: false },
    ],
    handler: async ({ topic }) => {
      if (topic && String(topic).trim()) {
        const slug = String(topic).trim();
        const result = await fetchMemoryJson(`/api/memory${q}&topic=${encodeURIComponent(slug)}`);
        const res = result.data;
        if (!result.ok && result.status === 404) {
          return `No topic "${slug}". Call memory_recall with no argument to see the index, or use memory_search with a keyword query.`;
        }
        if (!result.ok) return memoryError(result);
        if (res.error) return `Error: ${res.error}`;
        const entries = (res.entries ?? []) as { text: string; timestamp: string }[];
        if (!entries.length) return `Topic "${slug}" is empty.`;
        const digest = res.digest ? `> ${res.digest}\n` : "";
        return `## Topic: ${res.topic}\n${digest}\n- ${entries.map((e) => `[${e.timestamp}] ${e.text}`).join("\n- ")}`;
      }
      const result = await fetchMemoryJson(`/api/memory${q}`);
      if (!result.ok) return memoryError(result);
      const res = result.data;
      const preferences = String(res.preferences ?? "").trim();
      const index = (res.index ?? []) as { file: string; description: string }[];
      if (!preferences && index.length === 0) return "Memory is empty.";
      const prefBlock = preferences ? `# User preferences\n${preferences}` : "";
      const indexBlock = index.length
        ? `# Topics (call memory_recall with a slug to read one)\n${index
            .map((r) => `- ${r.file.replace(/^Topics\//, "").replace(/\.md$/, "")}: ${r.description}`)
            .join("\n")}`
        : "";
      return [prefBlock, indexBlock].filter(Boolean).join("\n\n");
    },
  });

  useCopilotAction({
    name: "memory_search",
    description:
      "Search your long-term memory (topic shards + recent episodes) for entries matching a query. Case-insensitive substring/word match; returns provenance (VFS path + in-file anchor), matched content, and a relevance score.",
    parameters: [
      { name: "query", type: "string", description: "Free-text query.", required: true },
      { name: "maxResults", type: "number", description: "Cap on results (default 10).", required: false },
    ],
    handler: async ({ query, maxResults }) => {
      const query2 = String(query ?? "").trim();
      if (!query2) return "Provide a query.";
      const params = new URLSearchParams({ agent: agentId, q: query2 });
      if (typeof maxResults === "number") params.set("maxResults", String(maxResults));
      const res = await fetch(`/api/memory/search?${params.toString()}`).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const results = (res.results ?? []) as { source: string; content: string; score: number }[];
      if (!results.length) return "No matches.";
      return results.map((r) => `- ${r.source} (score ${r.score})\n  ${r.content}`).join("\n");
    },
  });

  return null;
}
