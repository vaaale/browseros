"use client";

import { useCallback, useEffect, useState } from "react";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import type { Memory } from "@/lib/agent/memory/types";

// Exposes the self-improving memory to the agent: recent memories are always in
// context, and the agent can explicitly remember/recall.
export function MemoryActions() {
  const [memories, setMemories] = useState<Memory[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/memory").then((r) => r.json());
      setMemories((res.memories ?? []).slice(0, 12));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useCopilotReadable({
    description:
      "The agent's long-term memories (lessons, facts, preferences, procedures) learned from past sessions. Apply them when relevant.",
    value: memories.map((m) => ({ type: m.type, content: m.content, tags: m.tags })),
  });

  useCopilotAction({
    name: "rememberThis",
    description:
      "Save a durable memory for future sessions. Use for lessons learned, user preferences, useful facts, or procedures.",
    parameters: [
      { name: "content", type: "string", description: "What to remember (one sentence)", required: true },
      { name: "type", type: "string", description: "lesson | fact | preference | procedure", required: false },
      { name: "tags", type: "string[]", description: "Keywords for retrieval", required: false },
    ],
    handler: async ({ content, type, tags }) => {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, type, tags }),
      }).then((r) => r.json());
      await refresh();
      return res.error ? `Error: ${res.error}` : `Remembered: "${res.memory.content}"`;
    },
  });

  useCopilotAction({
    name: "recallMemories",
    description: "Search long-term memory for entries relevant to a query.",
    parameters: [{ name: "query", type: "string", description: "What to recall", required: true }],
    handler: async ({ query }) => {
      const res = await fetch(`/api/memory?q=${encodeURIComponent(query as string)}`).then((r) => r.json());
      const items = (res.memories ?? []) as Memory[];
      return items.length
        ? items.map((m) => `(${m.type}) ${m.content}`).join("\n")
        : "No relevant memories found.";
    },
  });

  return null;
}
