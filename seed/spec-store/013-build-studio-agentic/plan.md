# Implementation Plan: Build Studio Agentic V2 — Iterative App Design

**Branch**: `bos/bs-design-process` | **Date**: 2026-07-11 | **Spec**: `specs/bos-system-specs/013-build-studio-agentic/spec.md`

**Input**: Extend Build Studio so the agent can lead the user through an iterative design process for BrowserOS apps with a UI. The process interviews for requirements, designs functionality and UI, writes the spec live, renders UI via an A2UI surface, and delegates implementation to the Developer.

## Summary

This plan implements the V2 scope of spec `013-build-studio-agentic`: an iterative app-design flow for `bos-app` artifacts. The work is divided into four implementation phases:

1. **P1 — Surface-tools registry**: let mounted app windows register runtime (Tier 2) assistant tools so the agent can dispatch to the correct window.
2. **P2 — UI Preview app**: a built-in app that renders A2UI v0.9 surfaces and accepts live operations pushed by the agent.
3. **P3 — `a2ui_render` server tool**: a sub-agent-based tool that generates validated A2UI operations using `@ag-ui/a2ui-toolkit`.
4. **P4 — Spec viewer anchors/highlights**: a dedicated `buildstudio_artifact_highlight(anchor)` surface tool that centers the viewport on a section and highlights the whole section (not just the heading) until the user clicks it away. `buildstudio_artifact_open` stays anchor-free — opening and highlighting are separate tools.

The `bos-app` skill, Build Studio agent prompt, and developer guides are already in place.

## Technical Context

**Language/Version**: TypeScript 5.x, React 19, Next.js 15 (App Router), Node.js 22.

**Primary Dependencies**:
- `@copilotkit/a2ui-renderer` — renders A2UI surfaces in React.
- `@ag-ui/a2ui-toolkit` — toolkit for generating A2UI operations via a sub-agent.
- Existing CopilotKit runtime and BOS assistant client (`src/lib/assistant/client/run-client.ts`).

**Storage**: N/A for runtime surface tools; spec artifacts continue to live in external spec stores.

**Testing**: `npx tsc --noEmit`, `npm run lint`, Playwright e2e tests for the UI Preview app and Build Studio anchor/highlight behavior.

**Target Platform**: BrowserOS desktop (single-page Next.js app).

**Project Type**: Frontend + server-tool feature within BOS.

**Performance Goals**: UI Preview updates should feel live (< 500ms end-to-end from agent tool call to visible surface update in dev).

**Constraints**:
- No new external UI libraries; inline Tailwind only.
- A2UI surfaces run inside the existing `sandbox="allow-scripts"` iframe model.
- All BOS source changes stay on the active feature branch.
- Tier 2 tools must not leak to agents when the app window is closed.

**Scale/Scope**: Single built-in app + registry refactor + one server tool; scoped to `bos-app` design sessions in v2.

## Constitution Check

*Re-check after design and before implementation.*

- **Spec-first / source-second**: The agent writes specs before code; the Developer sub-agent writes code. This feature itself is no exception — this plan and the spec are the source of truth.
- **Never write BOS source directly**: P1–P4 source changes are delegated to the Developer sub-agent.
- **Server/client boundary**: Any new server state lives behind `/api/...` routes; client components do not import server-only modules.
- **Backward compatibility**: Changes to capabilities registry and surface-tool dispatch must not break existing Build Studio surface tools (`buildstudio_artifact_open`, `buildstudio_tree_refresh`).
- **Agent capabilities are permissioned**: New installed-app tools (Tier 1) and runtime surface tools (Tier 2) must flow through the existing per-agent capability allowlist mechanism.

No constitution violations identified.

## Project Structure

### Documentation (this feature)

```text
specs/bos-system-specs/013-build-studio-agentic/
├── spec.md              # Existing V1/V2 spec
├── plan.md              # This file
└── tasks.md             # Implementation tasks (next step)
```

### Source Code (repository root)

```text
src/
├── apps/
│   ├── ui-preview/
│   │   ├── manifest.ts           # App manifest for the UI Preview app
│   │   ├── index.tsx             # Main React component: A2UI renderer host
│   │   └── agent-tools-v2.ts     # Tier 2 surface tools (ui_preview_render, ui_preview_show_requirement)
│   └── build-studio/
│       ├── index.tsx             # Section-aware artifact viewer: center-scroll + whole-section highlight, click-to-dismiss
│       └── agent-tools-v2.ts     # NEW buildstudio_artifact_highlight(anchor) tool; buildstudio_artifact_open stays anchor-free
├── lib/
│   ├── assistant/
│   │   ├── client/
│   │   │   ├── run-client.ts     # Read active surface tools at send time
│   │   │   └── surface-tools.ts  # NEW: registry for active surface tools
│   │   └── tools/
│   │       └── server/
│   │           └── a2ui-render.ts  # NEW: a2ui_render server tool
│   └── agent/
│       └── capabilities-registry.ts  # Register ui_preview_open (Tier 1), ui_preview_render, etc.
└── components/
    └── agent/
        └── v2/
            └── AssistantChatV2.tsx  # Stop passing surfaceTools manually; read from registry
```

**Structure Decision**: Keep the registry in `src/lib/assistant/client/` alongside `run-client.ts` so it is colocated with the message-sending path. The UI Preview app is a new built-in app under `src/apps/ui-preview/`. The `a2ui_render` server tool lives with the other server tools.

## Design Notes

### P1 — Surface-tools registry

Current state: surface tools are passed explicitly into `sendMessage` (seen in `AssistantChatV2.tsx` and `ChatInputV2.tsx`).

Target state: a small client-side registry keyed by app window id.

- `registerAppSurfaceTools(windowId, declarations)`: called when an app window mounts.
- `unregisterAppSurfaceTools(windowId)`: called when an app window unmounts.
- `getActiveSurfaceToolDeclarations()`: returns the union of all registered declarations for the next agent run.
- `dispatchSurfaceTool(windowId, name, args)`: routes an invoked tool back to the correct app window's handler.

`run-client.ts` will call `getActiveSurfaceToolDeclarations()` when starting a run and include them as `surfaceTools`. Existing Build Studio surface tools can be migrated to the registry or kept as a baseline; the simplest path is to register them at app mount time like any other app.

### P2 — UI Preview app

- Manifest: `id: "ui-preview"`, singleton, no dock order (or low order).
- Component: hosts the A2UI renderer from `@copilotkit/a2ui-renderer`.
- Receives operations via `window.postMessage` or a React context broker from the surface-tool handler.
- Includes a lightweight "design context" panel showing the active requirement, iteration history, and user notes (FR-021).
- Tier 2 tools registered on mount:
  - `ui_preview_render(surfaceId, operations)` — apply A2UI operations.
  - `ui_preview_show_requirement(specPath, requirementId)` — ask Build Studio to show a requirement: calls `buildstudio_artifact_open(specPath)` (if not already the open artifact) then `buildstudio_artifact_highlight(requirementId)`.

Tier 1 tools (registered at install time):
- `ui_preview_open()` — open/raise the preview window.

### P3 — `a2ui_render` server tool

- Declaration: server tool `a2ui_render`.
- Implementation: uses `@ag-ui/a2ui-toolkit` to spawn a sub-agent with a constrained prompt.
- Sub-agent prompt includes the BOS style guide and A2UI catalog rules.
- Returns a validated operations envelope `{ surfaceId, operations }`.
- Uses the configured BOS provider/model (no separate model config).

### P4 — Spec viewer anchors and highlights

- `buildstudio_artifact_open(path)` stays exactly as-is: opens an artifact, no anchor parameter. Opening and highlighting are two separate tools/concerns — do not reintroduce an anchor param here.
- New surface tool `buildstudio_artifact_highlight(anchor)`, registered alongside Build Studio's other surface tools (`buildstudio_artifact_open`, `buildstudio_tree_refresh`):
  - Resolves `anchor` against the currently-open artifact's rendered heading ids (stable GitHub-style slugs derived from heading text — lowercase, spaces→hyphens, punctuation stripped).
  - Errors clearly if no artifact is open, or if `anchor` doesn't match any heading in the open artifact — never a silent no-op.
  - Scrolls the viewer so the target section is **centered**: `element.scrollIntoView({ block: "center", behavior: "smooth" })`, not `block: "start"`.
  - Highlights the **whole section**, not just the heading: determine the section's boundary by walking rendered siblings from the heading until the next heading of equal-or-higher level (h1 < h2 < h3 …), and wrap that range in a container that gets the highlight styling.
  - The highlighted container has an `onClick` that clears the highlight — this is the ONLY dismissal path. No `setTimeout`/auto-fade.
- In `BuildStudioApp`, track a single `highlightedAnchor: string | null` in state; render section-wrapper containers keyed by anchor so exactly one can be highlighted at a time, and clear it via the click handler rather than a timer.

## Complexity Tracking

No complexity violations.

## Open Questions / Risks

1. **A2UI renderer integration**: Need to verify that `@copilotkit/a2ui-renderer` exposes a clean React API or if we need a thin wrapper.
2. **Sub-agent model reuse**: `a2ui_render` must use the same provider/model as the current run; verify how to read the active agent/model configuration from a server tool context.
3. **Surface tool dispatch security**: Ensure a tool invocation cannot be routed to a window that has unregistered but not yet re-rendered.
4. **Feature branch state**: The plan assumes `bos/bs-design-process` remains the active branch for all P1–P4 work.
5. **Section-boundary detection**: react-markdown renders a flat list of sibling elements, not a nested section tree, so "heading + its content up to the next heading of equal-or-higher level" must be computed from that flat list (walk siblings, stop at the next heading whose level is ≤ the target's). Get this right or the highlight will either under- or over-select content.
6. **Click-target coverage**: the whole wrapped section (not just the heading) must be clickable to dismiss the highlight — including any padding/margin added for the highlight styling — so the user doesn't have to hunt for the exact dismiss spot.
