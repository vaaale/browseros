"use client";

import { useCopilotAction } from "@copilotkit/react-core";

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
    name: "buildstudio_artifact_open",
    description:
      "Open a specification artifact in the Build Studio viewer (the center pane) so the user can see it. Call this after you create or edit a spec, or when you reference one in the conversation. The path is STORE-PREFIXED, e.g. 'bos-system-specs/013-build-studio-agentic/spec.md'.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Store-prefixed artifact path, e.g. 'bos-system-specs/013-build-studio-agentic/spec.md'",
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
    name: "buildstudio_tree_refresh",
    description:
      "Reload the Build Studio spec tree and pipeline status from disk. Call after you create, rename, or delete a spec so the left tree reflects the change.",
    parameters: [],
    handler: async () => {
      onRefresh();
      return "Refreshed the spec tree.";
    },
  });

  useCopilotAction({
    name: "buildstudio_run_tests",
    description:
      "Run the Playwright e2e tests for a feature and write test-results.md to its spec folder. Call after the Developer has written tests. The test file must be named e2e/<feature-id>.spec.ts (e.g. e2e/001-my-feature.spec.ts). Refreshes the spec tree when done so the Test phase badge updates.",
    parameters: [
      {
        name: "featurePath",
        type: "string",
        description: "Store-prefixed feature path, e.g. 'user-specs/001-my-feature'",
        required: true,
      },
    ],
    handler: async ({ featurePath }) => {
      const p = String(featurePath ?? "").trim();
      if (!p) return "No featurePath provided.";
      try {
        const res = await fetch("/api/specs/run-tests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ featurePath: p }),
        }).then((r) => r.json());
        onRefresh();
        if (res.error) return `Error: ${res.error}`;
        return res.summary ?? "Tests complete.";
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });

  return null;
}
