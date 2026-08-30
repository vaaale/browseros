"use client";

// Build Studio's surface-scoped tools for the v2 embeddable Assistant
// (AssistantChatV2 `tools` prop). Same three tools the retired v1 AgentTools.tsx had, but as
// declaration+handler pairs: declarations ride on each run start; handlers are
// bound while the app is mounted and dispatched back here by the server loop.

import type { SurfaceTool } from "@/lib/assistant/client/surface-tools";

export function buildStudioSurfaceTools(opts: {
  // Returns the actual outcome (opened vs. could not load) — this is the
  // agent's only feedback channel, so it must reflect what really happened
  // rather than the tool reporting success the instant a fetch is kicked off.
  onOpen: (path: string) => Promise<string>;
  onHighlight: (anchor: string) => string | Promise<string>;
  onRefresh: () => void;
  // The real feature branch (if any) a write to `path` should land on — same
  // rule as spec-fs writes elsewhere (only non-empty for a user-specs path).
  getBranch: (path: string) => string;
}): SurfaceTool[] {
  return [
    {
      declaration: {
        name: "buildstudio_artifact_open",
        description:
          "Open a specification artifact in the Build Studio viewer (the center pane) so the user can see it. Call this after you create or edit a spec, or when you reference one in the conversation. The path is STORE-PREFIXED, e.g. 'bos-system-specs/013-build-studio-agentic/spec.md'. This tool only opens — to scroll to and highlight a specific section, call buildstudio_artifact_highlight afterward.",
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
        return opts.onOpen(p);
      },
    },
    {
      declaration: {
        name: "buildstudio_artifact_highlight",
        description:
          "Scroll the currently-open Build Studio artifact viewer to a heading/section anchor, centering it in the viewport, and highlight the WHOLE section (the heading and its content, not just the heading line) so the user notices it. The highlight has no timeout — it stays until the user clicks on it. Call this right after writing a section (e.g. a new requirement) so the user sees what changed. The anchor is a heading slug — lowercase, spaces to hyphens, punctuation stripped, e.g. 'user-story-1-work-with-the-build-studio-agent'. Requires an artifact to already be open (call buildstudio_artifact_open first) and the anchor to match a real heading in it.",
        parameters: {
          type: "object",
          properties: {
            anchor: { type: "string", description: "Heading slug to scroll to and highlight, e.g. 'user-story-1-work-with-the-build-studio-agent'." },
          },
          required: ["anchor"],
        },
      },
      handler: async ({ anchor }) => {
        const a = String(anchor ?? "").trim();
        if (!a) return "No anchor provided.";
        return opts.onHighlight(a);
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
          const branch = opts.getBranch(p);
          const res = await fetch("/api/specs/run-tests", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ featurePath: p, ...(branch ? { branch } : {}) }),
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
