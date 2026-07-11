"use client";

// UI Preview's Tier 2 (runtime) surface tools — only available to the agent
// while this window is open (013-build-studio-agentic V2). `ui_preview_open`
// (Tier 1, always offered) lives in frontend-declarations.ts + FrontendToolsV2
// alongside the other global app-launch tools.

import type { SurfaceTool } from "@/lib/assistant/client/surface-tools";
import { findSurfaceToolHandler } from "@/lib/assistant/client/surface-tools";

export function uiPreviewSurfaceTools(opts: {
  onRender: (surfaceId: string, operations: Record<string, unknown>[]) => void;
  onShowRequirement: (requirementId: string) => void;
}): SurfaceTool[] {
  return [
    {
      declaration: {
        name: "ui_preview_render",
        description:
          "Push A2UI v0.9 operations to the open UI Preview surface so the user sees the mockup update in place. Pass the exact { surfaceId, operations } envelope returned by a2ui_render — do not hand-edit it.",
        parameters: {
          type: "object",
          properties: {
            surfaceId: { type: "string", description: "The surface id from the a2ui_render envelope." },
            operations: {
              type: "array",
              description: "The A2UI v0.9 operations array from the a2ui_render envelope.",
              items: { type: "object" },
            },
          },
          required: ["surfaceId", "operations"],
        },
      },
      handler: async ({ surfaceId, operations }) => {
        const id = String(surfaceId ?? "").trim();
        if (!id) return "No surfaceId provided.";
        if (!Array.isArray(operations)) return "operations must be an array of A2UI operation objects.";
        opts.onRender(id, operations as Record<string, unknown>[]);
        return `Rendered ${operations.length} operation(s) on surface "${id}".`;
      },
    },
    {
      declaration: {
        name: "ui_preview_show_requirement",
        description:
          "Scroll the paired Build Studio spec viewer to a requirement/section while the user is looking at the UI Preview, and note it as the active requirement in the design-context panel. Only works while Build Studio is also open.",
        parameters: {
          type: "object",
          properties: {
            specPath: { type: "string", description: "Store-prefixed spec path, e.g. 'user-specs/001-my-app/spec.md'." },
            requirementId: { type: "string", description: "Heading anchor/section id of the requirement to highlight." },
          },
          required: ["specPath", "requirementId"],
        },
      },
      handler: async ({ specPath, requirementId }, ctx) => {
        const path = String(specPath ?? "").trim();
        const anchor = String(requirementId ?? "").trim();
        if (!path) return "No specPath provided.";
        if (!anchor) return "No requirementId provided.";
        opts.onShowRequirement(anchor);
        const openArtifact = findSurfaceToolHandler("buildstudio_artifact_open");
        const highlightArtifact = findSurfaceToolHandler("buildstudio_artifact_highlight");
        if (!openArtifact || !highlightArtifact) {
          return "Noted the active requirement (Build Studio is not open, so the viewer was not scrolled).";
        }
        await openArtifact({ path }, ctx);
        return highlightArtifact({ anchor }, ctx);
      },
    },
  ];
}
