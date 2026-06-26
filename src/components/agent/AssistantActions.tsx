"use client";

import { useCopilotAction } from "@copilotkit/react-core";

// Lets the assistant inspect and switch its personality profile.
export function AssistantActions() {
  useCopilotAction({
    name: "listProfiles",
    description: "List available assistant personality profiles and which one is active.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/assistant/profile").then((r) => r.json());
      return JSON.stringify({ active: res.active, profiles: (res.profiles ?? []).map((p: { id: string; name: string }) => p.id) });
    },
  });

  useCopilotAction({
    name: "switchProfile",
    description: "Switch the active assistant personality profile by id. Takes effect on the next message.",
    parameters: [{ name: "id", type: "string", description: "Profile id", required: true }],
    handler: async ({ id }) => {
      const res = await fetch("/api/assistant/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: id }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Active profile is now "${res.active}".`;
    },
  });

  return null;
}
