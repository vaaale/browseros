"use client";

// Build Studio's surface-scoped tools for the v2 embeddable Assistant
// (AssistantChatV2 `tools` prop). Same three tools as AgentTools.tsx, but as
// declaration+handler pairs: declarations ride on each run start; handlers are
// bound while the app is mounted and dispatched back here by the server loop.

import type { SurfaceTool } from "@/components/agent/v2/AssistantChatV2";

export function buildStudioSurfaceTools(opts: {
  onOpen: (path: string) => void;
  onRefresh: () => void;
}): SurfaceTool[] {
  return [
    {
      declaration: {
        name: "buildstudio_artifact_open",
        description:
          "Open a specification artifact in the Build Studio viewer (the center pane) so the user can see it. Call this after you create or edit a spec, or when you reference one in the conversation. The path is STORE-PREFIXED, e.g. 'bos-system-specs/013-build-studio-agentic/spec.md'.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Store-prefixed artifact path, e.g. 'bos-system-specs/013-build-studio-agentic/spec.md'" },
          },
          required: ["path"],
        },
      },
      handler: async ({ path }) => {
        const p = String(path ?? "")
          .trim()
          .replace(/^\/+/, "");
        if (!p) return "No path provided.";
        opts.onOpen(p);
        return `Opened ${p} in the Build Studio viewer.`;
      },
    },
    {
      declaration: {
        name: "buildstudio_tree_refresh",
        description:
          "Reload the Build Studio spec tree and pipeline status from disk. Call after you create, rename, or delete a spec so the left tree reflects the change.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      handler: async () => {
        opts.onRefresh();
        return "Refreshed the spec tree.";
      },
    },
    {
      declaration: {
        name: "buildstudio_run_tests",
        description:
          "Run the Playwright e2e tests for a feature and write test-results.md to its spec folder. Call after the Developer has written tests. The test file must be named e2e/<feature-id>.spec.ts (e.g. e2e/001-my-feature.spec.ts). Refreshes the spec tree when done so the Test phase badge updates.",
        parameters: {
          type: "object",
          properties: {
            featurePath: { type: "string", description: "Store-prefixed feature path, e.g. 'user-specs/001-my-feature'" },
          },
          required: ["featurePath"],
        },
      },
      handler: async ({ featurePath }) => {
        const p = String(featurePath ?? "").trim();
        if (!p) return "No featurePath provided.";
        try {
          const res = await fetch("/api/specs/run-tests", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ featurePath: p }),
          }).then((r) => r.json());
          opts.onRefresh();
          if (res.error) return `Error: ${res.error}`;
          return res.summary ?? "Tests complete.";
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    },
  ];
}
