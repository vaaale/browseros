# Feature Specification: Documentation Hub

**Feature Branch**: `010-documentation`

**Created**: 2026-06-28 (migrated from `spec/documentation/documentation.md`)

**Status**: Implemented

**Input**: "BOS keeps user-facing and developer-facing documentation in the repository and in sync with the code; the Docs app presents the user-facing material in the OS."

> Migrated from `spec/documentation/documentation.md`. The keep-in-sync rule is also a constitution principle (VI).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - End users can learn how to use BOS (Priority: P1)

User documentation under `docs/usage/**` is presented in the Docs app, organized into browsable sub-sections.

**Acceptance Scenarios**:

1. **Given** the Docs app, **When** the user browses Usage, **Then** they see the documentation tree from `docs/usage/` and can read each rendered page.

### User Story 2 - The developer agent has authoritative architecture docs (Priority: P1)

Developer documentation under `docs/dev/**` describes each subsystem in enough detail for an agent (e.g. Claude Code) to extend or modify BOS.

**Acceptance Scenarios**:

1. **Given** a development task, **When** the developer agent reads `docs/dev/`, **Then** it finds architecture, data layout, API routes, the assistant/sub-agent subsystem, and extension recipes.

### User Story 3 - Docs stay in sync with the code (Priority: P1)

Adding, modifying, or removing a feature updates the relevant docs in the same change.

**Acceptance Scenarios**:

1. **Given** a feature change, **When** it is implemented, **Then** the corresponding `docs/usage` and `docs/dev` pages are updated as part of that change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: User documentation MUST live under `docs/usage/` as human-readable markdown organized into sub-section directory trees; the Docs app MUST present it.
- **FR-002**: Developer documentation MUST live under `docs/dev/`, mirroring the usage structure, and MUST describe each subsystem (architecture, repository and `data/` layout, API routes, the assistant/sub-agent subsystem, extension recipes and design heuristics) in enough depth for an AI agent to make good design choices; `docs/dev/architecture-overview.md` is the entry point.
- **FR-003**: Whenever a feature is added, modified, or removed, the relevant `docs/usage` and `docs/dev` pages MUST be updated in the same change (per constitution principle VI).

### Key Entities

- **Docs app** — in-OS viewer for `docs/usage`.
- **`docs/usage/` tree** — end-user documentation.
- **`docs/dev/` tree** — developer/agent documentation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every built-in app/feature has a usage page under `docs/usage/`.
- **SC-002**: `docs/dev/` covers architecture, data layout, API routes, the assistant/sub-agent subsystem, and concrete extension recipes.
- **SC-003**: No feature ships without its documentation updated.

## Notes

- Faithful migration of `spec/documentation/documentation.md`; original prose remains in git history.
