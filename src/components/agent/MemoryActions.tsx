"use client";

import { useCopilotAction } from "@/components/agent/gated-action";

// The curated memory core (USER profile + agent MEMORY) is injected into the
// system instructions as a frozen snapshot at session start. These actions let
// the assistant write to it, and re-read the live state after a write (the
// snapshot itself stays frozen for the session).
export function MemoryActions() {
  useCopilotAction({
    name: "memory_save",
    description:
      "Save durable facts to persistent memory (survives across sessions; injected into future conversations). " +
      "target 'user' = who the user is (identity, role, preferences, style); 'memory' = your notes (environment, conventions, lessons). " +
      "Save proactively on preferences, corrections, and stable facts — the best memory stops the user repeating themselves. " +
      "Skip task logs, raw data, and easily re-discovered facts; reusable procedures belong in a skill. Memory is bounded: if full, " +
      "remove or shorten stale entries (replace/remove) to make room.",
    parameters: [
      { name: "target", type: "string", description: "'user' or 'memory'", required: true },
      { name: "action", type: "string", description: "add | replace | remove", required: true },
      { name: "content", type: "string", description: "Entry content (for add/replace)", required: false },
      { name: "oldText", type: "string", description: "Short unique substring of the entry to modify (for replace/remove)", required: false },
    ],
    handler: async ({ target, action, content, oldText }) => {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, action, content, oldText }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      return `${res.message ?? "Saved."} (${target} ${res.usage ?? ""})`;
    },
  });

  useCopilotAction({
    name: "memory_recall",
    description:
      "Read persistent memory. Without arguments returns USER, MEMORY, and the list of topic shards. Pass topic='<slug>' to load the entries of a specific topic file (e.g. 'gmail-workflows'). Use memory_search for keyword lookup across topics + episodes.",
    parameters: [
      { name: "topic", type: "string", description: "Optional topic slug to load a single topic's entries.", required: false },
    ],
    handler: async ({ topic }) => {
      if (topic && String(topic).trim()) {
        const slug = String(topic).trim();
        const res = await fetch(`/api/memory?topic=${encodeURIComponent(slug)}`).then((r) => r.json());
        if (res.error) return `Error: ${res.error}`;
        const entries = (res.entries ?? []) as { text: string; timestamp: string }[];
        if (!entries.length) return `Topic "${slug}" is empty.`;
        const digest = res.digest ? `> ${res.digest}\n` : "";
        return `## Topic: ${res.topic}\n${digest}\n- ${entries.map((e) => `[${e.timestamp}] ${e.text}`).join("\n- ")}`;
      }
      const res = await fetch("/api/memory").then((r) => r.json());
      const user = (res.user ?? []) as string[];
      const memory = (res.memory ?? []) as string[];
      const topics = (res.topics ?? []) as string[];
      if (!user.length && !memory.length && !topics.length) return "Memory is empty.";
      const fmt = (label: string, xs: string[]) => (xs.length ? `${label}:\n- ${xs.join("\n- ")}` : "");
      return [
        fmt("USER", user),
        fmt("MEMORY", memory),
        topics.length ? `TOPICS (call memory_recall with topic='<slug>' to load): ${topics.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  });

  useCopilotAction({
    name: "memory_search",
    description:
      "Search long-term memory (topic shards + recent episodes) for entries matching a query. Case-insensitive substring/word match; returns provenance (VFS path + in-file anchor), matched content, and a relevance score.",
    parameters: [
      { name: "query", type: "string", description: "Free-text query.", required: true },
      { name: "maxResults", type: "number", description: "Cap on results (default 10).", required: false },
    ],
    handler: async ({ query, maxResults }) => {
      const q = String(query ?? "").trim();
      if (!q) return "Provide a query.";
      const params = new URLSearchParams({ q });
      if (typeof maxResults === "number") params.set("maxResults", String(maxResults));
      const res = await fetch(`/api/memory/search?${params.toString()}`).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const results = (res.results ?? []) as { source: string; content: string; score: number }[];
      if (!results.length) return "No matches.";
      return results
        .map((r) => `- ${r.source} (score ${r.score})\n  ${r.content}`)
        .join("\n");
    },
  });

  return null;
}
