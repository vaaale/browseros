"use client";

import { useCopilotAction } from "@/components/agent/gated-action";

// The curated memory core (USER profile + agent MEMORY) is injected into the
// system instructions as a frozen snapshot at session start. These actions let
// the assistant write to it, and re-read the live state after a write (the
// snapshot itself stays frozen for the session).
export function MemoryActions() {
  useCopilotAction({
    name: "memory",
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
    name: "recallMemories",
    description:
      "Read the live persistent memory entries (user profile and agent notes). Use to see the current state, e.g. after writing.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/memory").then((r) => r.json());
      const user = (res.user ?? []) as string[];
      const memory = (res.memory ?? []) as string[];
      if (!user.length && !memory.length) return "Memory is empty.";
      const fmt = (label: string, xs: string[]) => (xs.length ? `${label}:\n- ${xs.join("\n- ")}` : "");
      return [fmt("USER", user), fmt("MEMORY", memory)].filter(Boolean).join("\n\n");
    },
  });

  return null;
}
