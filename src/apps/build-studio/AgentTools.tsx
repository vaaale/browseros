"use client";

import { useCopilotAction } from "@/components/agent/gated-action";

// Frontend tools the Build Studio agent can call to DRIVE the app's UI. They are
// registered inside the app's embedded chat provider (via AssistantChat's children
// slot), so they are available to the build-studio agent running in this app — but
// not to the normal Assistant. They let the agent show its work (open the spec it
// just wrote) and keep the tree in sync after it edits files. These are distinct
// from the agent's spec FILE tools (which read/write under specs/).
export function BuildStudioAgentTools({
  onOpen,
  onRefresh,
}: {
  onOpen: (path: string) => void;
  onRefresh: () => void;
}) {
  useCopilotAction({
    name: "openSpecArtifact",
    description:
      "Open a specification artifact in the Build Studio viewer (the center pane) so the user can see it. Call this after you create or edit a spec, or when you reference one in the conversation. The path is under specs/ or .specify/, e.g. 'specs/013-build-studio-agentic/spec.md'.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Artifact path, e.g. 'specs/013-build-studio-agentic/spec.md' or '.specify/memory/constitution.md'",
        required: true,
      },
    ],
    handler: async ({ path }) => {
      const p = String(path ?? "")
        .trim()
        .replace(/^\/+/, "");
      if (!p) return "No path provided.";
      onOpen(p);
      return `Opened ${p} in the Build Studio viewer.`;
    },
  });

  useCopilotAction({
    name: "refreshSpecTree",
    description:
      "Reload the Build Studio spec tree and pipeline status from disk. Call after you create, rename, or delete a spec so the left tree reflects the change.",
    parameters: [],
    handler: async () => {
      onRefresh();
      return "Refreshed the spec tree.";
    },
  });

  return null;
}
