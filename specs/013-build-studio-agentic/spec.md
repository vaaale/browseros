# Feature Specification: Build Studio — Agentic Studio (idea → built feature)

**Feature Branch**: `013-build-studio-agentic`

**Created**: 2026-06-28

**Status**: Implemented (v1)

**Input**: "Make Build Studio an agentic studio: embed the assistant (scoped to the Build Studio agent) so the user works conversationally to create/refine specs and build features end-to-end (idea → spec → clarify → plan → tasks → implemented by the Developer), alongside the spec tree."

> Extends `001-build-studio` (v1: spec tree + viewer/editor + the Build Studio agent + spec tools + `delegate_to_developer` + the Build Studio skill). v1 was authoring-only and had **no agent in the app**; this makes the app agentic. Depends on `011-per-agent-capabilities` (scoped BS agent) and `012-embeddable-assistant` (the embed).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work with the Build Studio agent inside the app (Priority: P1)

The Build Studio app embeds the assistant (per `012`) pinned to the **Build Studio agent**, with the Assistant side panels hidden and the spec tree on the left.

**Acceptance Scenarios**:

1. **Given** the Build Studio app, **When** it opens, **Then** a chat with the Build Studio agent is the main surface, beside the spec tree.

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

### User Story 6 - Context-aware (Priority: P2)

The chat is aware of the selected feature/artifact; the tree + pipeline status update as the agent writes specs and builds.

### Edge Cases

- Build monitoring, testing, and sign-off (promote/discard) MUST use the **existing self-modification pipeline** — no parallel implementation.
- If the Developer/harness is unavailable, the build step reports clearly while authoring still works.
- Conversations are stored/managed like the Assistant (per `012`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Build Studio app MUST embed the assistant (per `012`) pinned to the **Build Studio agent**, with the conversation + info side panels hidden, and the spec tree retained on the left.
- **FR-002**: From the embedded chat the user MUST be able to create a new feature spec from an idea, refine/clarify it, generate plan + tasks, and trigger the build — via the Build Studio agent's tools (spec tools + `delegate_to_developer`).
- **FR-003**: The **default Assistant MUST delegate spec/feature-authoring requests to the Build Studio agent** (a core delegation rule), so the user can also build specs from the normal Assistant.
- **FR-004**: The Build Studio agent MUST treat the **constitution as special**: a request that would require a constitution change MUST trigger scrutiny and collaboration on alternatives, never a blind edit.
- **FR-005**: After a build completes, the agent MUST run analyze + converge; if discrepancies are found it MUST ask the user for confirmation, then instruct the Developer to fix them.
- **FR-006**: Build monitoring MUST use the assistant's existing live-event UI (via `012`); testing and sign-off (promote/discard) MUST use the existing self-modification pipeline **unchanged**.
- **FR-007**: The chat MUST be context-aware of the selected feature/artifact; the tree + pipeline status MUST refresh as the agent writes specs and builds.
- **FR-008**: Conversations MUST be stored/managed the same way as the Assistant (per `012`).
- **FR-009**: Manual artifact editing (from `001`) remains available as a secondary affordance.

### Key Entities

- **Build Studio app** — spec tree + embedded agent chat.
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

## Assumptions & Dependencies

- Depends on `011-per-agent-capabilities` (scoped BS agent) and `012-embeddable-assistant` (the embed).
- Builds on `001-build-studio` (the spec tree, the BS agent, spec tools, `delegate_to_developer`, the Build Studio skill).
- The self-modification pipeline (`005`–`008`) handles testing + promote/discard unchanged.
