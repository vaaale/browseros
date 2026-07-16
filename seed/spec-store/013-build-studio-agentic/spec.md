# Feature Specification: Build Studio — Agentic Studio (idea → built feature)

**Feature Branch**: `013-build-studio-agentic`

**Created**: 2026-06-28

**Status**: Implemented (v1) / In Progress (v2)

**Input**: "Make Build Studio an agentic studio: embed the assistant (scoped to the Build Studio agent) so the user works conversationally to create/refine specs and build features end-to-end (idea → spec → clarify → plan → tasks → implemented by the Developer), alongside the spec tree."

> Extends `001-build-studio` (v1: spec tree + viewer/editor + the Build Studio agent + spec tools + `delegate_to_developer` + the Build Studio skill). v1 was authoring-only and had **no agent in the app**; this makes the app agentic. Depends on `011-per-agent-capabilities` (scoped BS agent) and `012-embeddable-assistant` (the embed).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work with the Build Studio agent inside the app (Priority: P1)

The Build Studio app embeds the assistant (per `012`) pinned to the **Build Studio agent**, added as a third pane **beside the existing `001` surfaces** — the spec tree (left) and the artifact viewer/editor (center) — with the assistant info panel hidden and its own (Build Studio group) conversation panel shown.

**Acceptance Scenarios**:

1. **Given** the Build Studio app, **When** it opens, **Then** the spec tree, the artifact viewer/editor, and a chat with the Build Studio agent are all present (the chat is added, not a replacement for the content area).
2. **Given** a feature in the tree, **When** the user clicks it, **Then** its artifact still opens in the viewer/editor (adding the chat did not break tree selection or the viewer).

### User Story 2 - Idea → built feature (Priority: P1)

From the chat the user goes from an idea to a created/refined spec (specify → clarify → plan → tasks) to an **implemented feature** (the agent delegates the build to the Developer), with live progress.

**Acceptance Scenarios**:

1. **Given** an idea typed in the chat, **When** the user asks to build it, **Then** the agent creates the spec, refines it with the user, generates plan + tasks, and delegates implementation to the Developer — streaming progress.
2. **Given** the build runs, **When** the Developer works, **Then** its events appear live in the chat (via `012`).

### User Story 3 - Either entry point (Priority: P1)

The user can do this in Build Studio or in the normal Assistant; the **default Assistant delegates spec/feature-authoring requests to the Build Studio agent**.

**Acceptance Scenarios**:

1. **Given** the default Assistant, **When** the user asks for spec/feature work, **Then** it delegates to the Build Studio agent.

### User Story 4 - The constitution is protected (Priority: P1)

If a request would require changing the constitution, the agent does not blindly comply — it verifies the change is the right call and collaborates with the user on alternatives that avoid it.

**Acceptance Scenarios**:

1. **Given** a request that would require a constitution change, **When** the agent recognizes this, **Then** it pauses, explains, and proposes alternatives before any constitution edit.

### User Story 5 - Post-build verification (Priority: P2)

After a build, the agent runs analyze + converge; on drift it asks the user for confirmation, then instructs the Developer to fix.

**Acceptance Scenarios**:

1. **Given** a completed build, **When** the agent runs its checks and finds drift, **Then** it asks the user before instructing the Developer to fix it.

### User Story 6 - Context-aware & able to drive the app (Priority: P2)

The chat is aware of the selected feature/artifact; the agent can also **drive the app's UI** — opening the spec it just wrote in the viewer and refreshing the tree — and the tree + pipeline status update as the agent writes specs and builds.

**Acceptance Scenarios**:

1. **Given** the agent has just created or edited a spec, **When** it finishes, **Then** it opens that artifact in the viewer (via its app-control tool) and the tree reflects the new/changed file.
2. **Given** a wide or narrow window, **When** the user drags a side-pane divider, **Then** the tree or chat pane resizes and the width persists when the app is reopened.

### Edge Cases

- Adding the chat to the `001` app MUST be **additive**: a re-implementation MUST NOT collapse the app to "tree + chat only" (an earlier attempt did this — the chat covered the whole content area and the tree no longer selected specs). Keep the tree (with working selection) and the viewer/editor; the chat is a third pane.
- Build monitoring, testing, and sign-off (promote/discard) MUST use the **existing self-modification pipeline** — no parallel implementation.
- If the Developer/harness is unavailable, the build step reports clearly while authoring still works.
- Conversations are stored/managed like the Assistant (per `012`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Build Studio app MUST embed the assistant (per `012`) pinned to the **Build Studio agent**, added as an **additional pane that preserves the `001` surfaces**: the layout MUST keep the spec tree (left) and the artifact viewer/editor (center, per `001` FR-006/FR-007) and place the chat alongside them. Embedding the chat MUST NOT replace or disable the tree's feature/file selection or the viewer/editor (it is an additive change to an existing app, not a rebuild of its content area). The embedded chat MUST show its **own (Build Studio group) conversation panel** and MUST hide the assistant **info** side panel. The two side panes (spec tree and chat) MUST be **user-resizable** via draggable dividers (the center viewer absorbs the remaining width); the chosen widths SHOULD persist across sessions.
- **FR-002**: From the embedded chat the user MUST be able to create a new feature spec from an idea, refine/clarify it, generate plan + tasks, and trigger the build — via the Build Studio agent's tools (spec tools + `delegate_to_developer`).
- **FR-003**: The **default Assistant MUST delegate spec/feature-authoring requests to the Build Studio agent** (a core delegation rule), so the user can also build specs from the normal Assistant.
- **FR-004**: The Build Studio agent MUST treat the **constitution as special**: a request that would require a constitution change MUST trigger scrutiny and collaboration on alternatives, never a blind edit.
- **FR-005**: After a build completes, the agent MUST run analyze + converge; if discrepancies are found it MUST ask the user for confirmation, then instruct the Developer to fix them.
- **FR-006**: Build monitoring MUST use the assistant's existing live-event UI (via `012`); testing and sign-off (promote/discard) MUST use the existing self-modification pipeline **unchanged**.
- **FR-007**: The chat MUST be context-aware of the selected feature/artifact; the tree + pipeline status MUST refresh as the agent writes specs and builds.
- **FR-008**: Conversations MUST be stored/managed the same way as the Assistant (per `012`).
- **FR-009**: Manual artifact editing (from `001`) remains available as a secondary affordance.
- **FR-010**: The app MUST give the embedded agent **frontend tools to drive the app's UI** — registered in the app's chat provider (via the embed's children slot) so they are callable by the build-studio agent but not by the normal Assistant, and **distinct from the agent's spec FILE tools** (which read/write under `specs/`). At minimum: **open a specification artifact in the viewer** (so the agent can show the user the spec it created, edited, or is discussing) and **refresh the spec tree + pipeline status** (after the agent writes, renames, or deletes files). These actions render as ordinary tool-call cards in the chat. (Without them the agent could change files on disk but could not reflect those changes in the app it lives in — the gap this FR closes.)

### Key Entities

- **Build Studio app** — spec tree + artifact viewer/editor (from `001`) + embedded agent chat (three panes).
- **Build Studio agent** — the scoped (per `011`) spec-authoring personality.
- **Embedded assistant** — the chat surface (per `012`).
- **Spec pipeline** — the spec-kit phases (from `001`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from an idea to a built feature entirely within Build Studio.
- **SC-002**: The same is possible from the normal Assistant (which delegates to the Build Studio agent).
- **SC-003**: A constitution-impacting request is challenged and collaborated on, not blindly applied.
- **SC-004**: After a build, drift is detected and only fixed after user confirmation.
- **SC-005**: Build progress, testing, and sign-off reuse the existing assistant + self-modification machinery (no parallel implementation).
- **SC-006**: Opening Build Studio shows three working panes — spec tree (selecting a feature opens its artifact), viewer/editor, and the Build Studio chat — with none replacing another.
- **SC-007**: The agent can open a named spec artifact in the viewer and refresh the tree from the chat (its app-control tools work end-to-end).
- **SC-008**: The spec-tree and chat side panes can be resized by dragging, and the widths persist across reopen.

## Assumptions & Dependencies

- Depends on `011-per-agent-capabilities` (scoped BS agent) and `012-embeddable-assistant` (the embed).
- Builds on `001-build-studio` (the spec tree, the BS agent, spec tools, `delegate_to_developer`, the Build Studio skill).
- The self-modification pipeline (`005`–`008`) handles testing + promote/discard unchanged.

---

## V2: Iterative App Design Process with Live UI Preview

**Status**: Implemented, pending live end-to-end validation (tasks.md T031)

**Input**: Extend Build Studio so the agent can lead the user through an iterative design process for BrowserOS apps, starting with apps that have a UI. The agent interviews the user for requirements, designs functionality and UI, writes the spec live, renders the UI via an A2UI surface, and delegates implementation to the Developer. This phase also introduces a two-tier system for app-registered assistant tools: installed-app tools (static, permissioned per agent in Settings) and runtime surface tools (dynamic, available only when an app window is open).

### V2 User Scenarios & Testing

#### User Story 7 - Categorize the request (Priority: P1)

The agent first determines whether the user wants to build a `bos-app`, `bos-integration`, `bos-feature`, or `bos-core` artifact. For v2 the scope is `bos-app` (apps with a UI).

**Acceptance Scenarios**:

1. **Given** a user request, **When** the agent starts the design process, **Then** it confirms the category is `bos-app`; if not, it explains which skill/category applies and offers to switch or delegate.

#### User Story 8 - Interview-driven requirements (Priority: P1)

The agent interviews the user to gather requirements. Each confirmed requirement is appended to the spec live, and the spec viewer automatically scrolls to and centers the new requirement, highlighting the whole section so the user notices it. The highlight is not time-based — it stays until the user dismisses it by clicking on it.

**Acceptance Scenarios**:

1. **Given** the agent has gathered a requirement, **When** it writes it to the spec, **Then** it opens the spec in Build Studio, scrolls the viewer so the new section is centered in the viewport (when possible), and highlights the whole section (not just the heading line).
2. **Given** the user revises a requirement, **When** the agent edits the spec, **Then** the viewer reflects the change and highlights the updated section the same way.
3. **Given** a highlighted section, **When** the user clicks anywhere on it, **Then** the highlight is removed immediately (no auto-timeout).

#### User Story 9 - Live UI design via A2UI (Priority: P1)

For apps with a UI, the agent opens the UI Preview app and renders/updates mockups using the A2UI protocol. The user sees the design evolve as the interview progresses.

**Acceptance Scenarios**:

1. **Given** the design process has reached the UI phase, **When** the agent opens the UI Preview app, **Then** a sandboxed A2UI surface is visible in a BOS window.
2. **Given** the user requests a UI change, **When** the agent regenerates the design, **Then** the surface updates in place without opening an additional window.
3. **Given** the user provides feedback on a rendered component, **When** the agent updates only that area, **Then** the change is reflected while the rest of the surface remains stable.

#### User Story 10 - Two-tier app-registered assistant tools (Priority: P1)

Apps can register assistant-facing tools. Installed apps contribute static tools that appear in Settings → Agents → [agent] → Tools, grouped by app name. Runtime app surfaces contribute dynamic tools that are only available while the app's window is open.

**Acceptance Scenarios**:

1. **Given** the UI Preview app is installed, **Then** its Tier 1 tools (e.g. `ui_preview_open`) appear in the agent capability picker grouped under "UI Preview" and can be allowed/revoked per agent.
2. **Given** the UI Preview window is open, **Then** its Tier 2 tools (e.g. `ui_preview_render`) are available to the agent and dispatched to the correct window.
3. **Given** the UI Preview window is closed, **Then** its Tier 2 tools are no longer offered in new runs.

#### User Story 11 - Delegate to Developer (Priority: P1)

Once the spec and UI design are approved, the agent delegates implementation to the Developer sub-agent, using the existing self-modification pipeline.

**Acceptance Scenarios**:

1. **Given** the user approves the spec and UI, **When** the agent delegates, **Then** the Developer receives the spec, plan, tasks, and UI artifacts and begins implementation.
2. **Given** the Developer finishes, **Then** the Build Studio agent runs analyze + converge and reports the result.

### V2 Requirements

#### Functional Requirements

- **FR-011**: The Build Studio agent MUST support an iterative design process for `bos-app` features. The process MUST include: orient, categorize, interview, write spec live, design UI live (when applicable), finalize plan + tasks, and delegate implementation.
- **FR-012**: The agent MUST load and follow the `bos-app` skill. The skill MUST reference the constitution, design heuristics (`docs/dev/design-heuristics.md`), architecture overview (`docs/dev/architecture-overview.md`), BOS UI style guide (`docs/dev/guides/style-guide.md`), apps guide (`docs/dev/guides/apps.md`), features & components guide (`docs/dev/guides/features-and-components.md`), spec templates (`.specify/templates/`), and app-specific references (`references/design-interview-script.md`, `references/ui-conventions.md`, `references/a2ui-catalog.md`).
- **FR-013**: The agent MUST categorize the request before starting detailed design. For v2 it MUST confirm the category is `bos-app` (or explain that a different skill is needed for `bos-integration`, `bos-feature`, or `bos-core`).
- **FR-014**: The agent MUST write spec content live: after gathering each significant requirement or design decision it MUST append it to the spec using `spec_write`/`spec_edit`, then call `buildstudio_artifact_open` (if the spec isn't already open) followed by `buildstudio_artifact_highlight` with the section's anchor so the user can see what was written.
- **FR-015**: Build Studio's artifact viewer MUST support opening any spec artifact. The agent MUST expose this via the `buildstudio_artifact_open(path)` surface tool, where `path` is a store-prefixed artifact path. This tool MUST NOT accept an anchor or perform any scrolling/highlighting — opening and highlighting are separate concerns (see FR-015a).
- **FR-015a**: Build Studio's artifact viewer MUST support scrolling to and highlighting a stable heading/section anchor in the currently-open artifact. The agent MUST expose this via a `buildstudio_artifact_highlight(anchor)` surface tool. Calling it MUST:
  1. Smooth-scroll the viewer so the target section is **centered** in the viewport when possible (not merely scrolled into view at the top/bottom).
  2. Highlight the **whole section** — the heading plus its body content up to (but not including) the next heading of equal or higher level — not just the heading line, so the highlighted region is obviously visible.
  3. Keep the highlight visible with **no auto-timeout**; it is dismissed only when the user clicks anywhere inside the highlighted section, at which point it MUST be removed immediately.
  If no artifact is currently open, or `anchor` does not match any heading in the open artifact, the tool MUST return a clear error to the agent instead of silently doing nothing.
- **FR-016**: When the app has a UI, the agent MUST open the UI Preview app via `bos_app_launch` at the start of the UI phase and keep it open for the remainder of the design session.
- **FR-017**: The UI Preview app MUST render A2UI v0.9 surfaces using `@copilotkit/a2ui-renderer`. It MUST accept A2UI operations pushed by the agent and apply them to update the live surface.
- **FR-018**: The system MUST provide a server tool `a2ui_render` (or equivalent) that uses `@ag-ui/a2ui-toolkit` to run a sub-agent producing A2UI operations. The tool MUST use the configured BOS provider/model and return a validated operations envelope.
- **FR-019**: Apps MUST be able to register assistant tools through a two-tier system:
  - **Tier 1 — installed-app tools**: declared in the app manifest or a static `agent-tools.ts`, registered in the capabilities inventory, grouped by app name in Settings → Agents → [agent] → Tools, and permissioned per agent.
  - **Tier 2 — runtime surface tools**: declared by a mounted app window via `registerAppSurfaceTools`, sent as `surfaceTools` at run start, and only available while the app window is open.
- **FR-020**: The UI Preview app MUST register tools in both tiers. Tier 1 MUST include at minimum `ui_preview_open` (open/raise the preview window). Tier 2 MUST include at minimum `ui_preview_render` (push operations to the surface) and `ui_preview_show_requirement` (open the paired spec artifact if needed, then scroll to and highlight a requirement — composing `buildstudio_artifact_open` and `buildstudio_artifact_highlight`).
- **FR-021**: The UI Preview app SHOULD display the current design surface plus a lightweight "design context" panel showing the active requirement, iteration history, and user notes.
- **FR-022**: The `bos-app` skill MUST instruct the agent to delegate implementation to the Developer sub-agent once the spec and UI are approved, using the existing `delegate_to_developer`/`dev_delegate` flow and the self-modification pipeline.

### V2 Success Criteria

- **SC-009**: A user can describe an app idea and the agent interviews them, producing a visible, continuously updated spec.
- **SC-010**: The agent can open the UI Preview app and render/update a UI mockup live using A2UI.
- **SC-011**: Build Studio's spec viewer can scroll to, center, and highlight a whole section on demand; the highlight persists until the user clicks it away (no auto-timeout).
- **SC-012**: App tools are discoverable and permissioned: installed-app tools appear in Settings → Agents → Tools grouped by app; runtime tools work only while the app window is open.
- **SC-013**: The end-to-end flow (interview → spec → UI → delegate) works from Build Studio and from the default Assistant delegating to the Build Studio agent.

### V2 Assumptions & Dependencies

- Depends on `011-per-agent-capabilities` (scoped agent tools) and `012-embeddable-assistant` (chat surface + surface tools).
- Depends on `009-installed-apps` (app manifest/installation model) for Tier 1 tool registration.
- Uses the existing `@copilotkit/a2ui-renderer` and `@ag-ui/a2ui-toolkit` packages already present in `node_modules`.
- A2UI starts with the basic catalog; a BOS-native design catalog may be added later.
- BOS source modifications are delegated to the Developer sub-agent per `005`–`008`.
