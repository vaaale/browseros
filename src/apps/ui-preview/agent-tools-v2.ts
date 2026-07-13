"use client";

// UI Preview's Tier 2 (runtime) surface tools — only available to the agent
// while this window is open (013-build-studio-agentic V2). `ui_preview_open`
// (Tier 1, always offered) lives in frontend-declarations.ts + FrontendToolsV2
// alongside the other global app-launch tools.
//
// 025-ui-preview-a2ui-tools: the agent no longer generates an A2UI envelope
// with one tool (`a2ui_render`) and pushes it with another (`ui_preview_render`)
// — a two-step split the model frequently forgot to complete, leaving a
// generated mockup un-rendered. Instead `ui_preview_generate` and
// `ui_preview_patch` each generate AND render in a single call: the handler
// posts the natural-language request to `/api/a2ui` (the server holds the LLM
// provider secrets), gets back a validated operations envelope, and renders it
// into the live surface itself.

import type { SurfaceTool } from "@/lib/assistant/client/surface-tools";
import { findSurfaceToolHandler } from "@/lib/assistant/client/surface-tools";

interface A2UIResponse {
  ok: boolean;
  surfaceId: string;
  operations: Record<string, unknown>[];
  error?: string;
}

async function callA2UI(body: Record<string, unknown>, signal: AbortSignal): Promise<A2UIResponse> {
  const res = await fetch("/api/a2ui", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return (await res.json()) as A2UIResponse;
}

export function uiPreviewSurfaceTools(opts: {
  onRender: (surfaceId: string, operations: Record<string, unknown>[]) => void;
  onShowRequirement: (requirementId: string) => void;
  getCurrentSurface: () => { surfaceId: string; components: Record<string, unknown>[] };
}): SurfaceTool[] {
  return [
    {
      declaration: {
        name: "ui_preview_generate",
        description:
          "Generate a UI mockup from a natural-language description and render it in the open UI Preview window in one step. Use this to create a NEW mockup (or fully replace the current one); use ui_preview_patch to change an existing one. " +
          "IMPORTANT — this is NOT an HTML/CSS/JavaScript page: it renders a fixed set of A2UI components (Text, Row, Column, Card, Tabs, Button, TextField, CheckBox, ChoicePicker, Slider, DateTimeInput, Image, Icon, Divider, Modal, List). Do NOT ask for '<script>', 'vanilla JavaScript', a 'showStep() function', 'localStorage', or 'CSS display:none' — none of that exists and it will be silently ignored. Describe STRUCTURE, CONTENT, and BEHAVIOR in terms of those components. " +
          "Interactivity is real but works a specific way: multi-tab/multi-step UIs use the Tabs component (clicking a tab header switches it; to make a 'Next'/'Back' button change tabs, bind the Tabs 'activeTab' to a data path and have the button set that path). Inputs keep their value when bound to a data path; a Text bound to that path shows it live. Don't claim behavior works unless it's expressed through these components.",
        parameters: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Natural-language description of the UI to build, e.g. 'a login form with an email field, a password field, and a Sign in button'.",
            },
          },
          required: ["description"],
        },
      },
      handler: async ({ description }, ctx) => {
        const desc = String(description ?? "").trim();
        if (!desc) return "No description provided.";
        try {
          const result = await callA2UI({ mode: "generate", description: desc }, ctx.signal);
          if (!result.ok) return `Error: ${result.error ?? "could not generate the UI."}`;
          opts.onRender(result.surfaceId, result.operations);
          return `Generated and rendered a new mockup (${result.operations.length} operation(s)) on the UI Preview surface.`;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    },
    {
      declaration: {
        name: "ui_preview_patch",
        description:
          "Make an incremental change to the mockup already showing in the UI Preview window — add, replace, or remove elements — from a natural-language instruction, e.g. 'replace the dropdown with radio buttons' or 'add a Cancel button next to Submit'. Reads the current mockup itself, so just describe the change; do not restate the whole design. Use ui_preview_generate instead to start a brand-new mockup. " +
          "Same medium rules as ui_preview_generate: it edits A2UI components, NOT HTML/CSS/JS — never ask for scripts, JavaScript functions, or CSS toggling; express behavior through the components (Tabs for tabbed/stepped navigation, data-path-bound inputs and Text for live values).",
        parameters: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Natural-language description of the change to apply to the current mockup.",
            },
          },
          required: ["description"],
        },
      },
      handler: async ({ description }, ctx) => {
        const desc = String(description ?? "").trim();
        if (!desc) return "No description provided.";
        const { surfaceId, components } = opts.getCurrentSurface();
        if (components.length === 0) {
          return "There is no mockup to patch yet — use ui_preview_generate to create one first.";
        }
        try {
          const result = await callA2UI({ mode: "patch", description: desc, surfaceId, currentComponents: components }, ctx.signal);
          if (!result.ok) return `Error: ${result.error ?? "could not apply the change."}`;
          opts.onRender(result.surfaceId, result.operations);
          return `Applied the change to the UI Preview surface (${result.operations.length} operation(s)).`;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
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
