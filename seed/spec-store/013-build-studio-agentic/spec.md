# Feature Specification: Build Studio — Agentic Studio (idea → built feature)

**Feature Branch**: `013-build-studio-agentic`

**Created**: 2026-06-28

**Status**: Implemented (v1)

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
