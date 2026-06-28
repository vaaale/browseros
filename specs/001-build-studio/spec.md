# Feature Specification: Build Studio

**Feature Branch**: `001-build-studio`

**Created**: 2026-06-28

**Status**: Draft

**Input**: User description: "BOS includes a Software-As-A-Prompt subsystem. Build Studio is a specialized spec-authoring agent plus a companion app that uses GitHub spec-kit to author and refine specifications under `specs/`, and delegates implementation to the existing Developer sub-agent. The app has a left tree of the spec structure and a main pane that visualizes spec development."

## Clarifications

### Session 2026-06-28

- Q: How are concurrent edits to a spec from the app and the agent handled? → A: The app is a viewer plus manual editor. While a Build Studio pipeline step is running against a feature, that feature's artifacts are read-only in the app. All writes use atomic file writes; otherwise last-write-wins (no locking service).
- Q: How are feature folder identifiers assigned? → A: Auto-numbered `NNN-slug` (zero-padded 3-digit; next = max existing + 1; slug from the feature name; numeric suffix on collision), mirroring spec-kit.
- Q: Which spec-kit commands are in scope for v1? → A: The authoring loop (constitution, specify, clarify, plan, tasks), implement (delegated), and the drift loop (analyze, converge). `checklist` and `taskstoissues` are deferred (`taskstoissues` is GitHub-issue-specific and out of scope for BOS).
- Q: Can Build Studio delegate `/implement` only as the active personality, or also when nested? → A: Also when nested. Build Studio gets a `delegate_to_developer` tool in its sub-agent tool set, so implement works both as the active personality and when delegated by another agent; the nested Developer's events stream into the existing nested event UI.
- Q: What drives Build Studio's behavior, and how is it extended? → A: A skill-driven design — the agent prompt is thin and a "Build Studio" skill (with per-command references) encodes the pipeline. New capabilities are added as companion skills plus any tool/MCP they require (e.g. a future GitLab integration), with no change to the agent or app code.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author a feature spec through the spec-kit pipeline (Priority: P1)

A builder describes a feature in natural language; Build Studio drafts a spec-kit
`spec.md` under `specs/<NNN-feature>/`, then guides them through clarify → plan →
tasks, producing each artifact from the vendored templates.

**Why this priority**: This is the core of Software-As-A-Prompt — turning intent into
an authoritative specification. Nothing else in the subsystem has value without it.

**Independent Test**: Ask Build Studio to specify a small feature; verify a
template-conformant `specs/<NNN>/spec.md` is created and that clarify, plan, and tasks
each produce their artifacts consistent with the spec and the constitution.

**Acceptance Scenarios**:

1. **Given** a one-line feature idea, **When** the user runs specify, **Then** a new `specs/<NNN-feature>/spec.md` is created from the template with user stories, functional requirements, and success criteria.
2. **Given** a draft spec containing ambiguities, **When** the user runs clarify, **Then** a Clarifications section is appended capturing the resolved questions.
3. **Given** an agreed spec, **When** the user runs plan then tasks, **Then** `plan.md` and `tasks.md` are produced that are consistent with the spec and constitution.

---

### User Story 2 - Browse the spec tree and visualize pipeline state (Priority: P1)

A user opens the Build Studio app and sees a navigable tree of `specs/`; selecting a
feature shows its artifacts and its position in the pipeline
(constitution → specify → clarify → plan → tasks → implement), with the active
artifact rendered.

**Why this priority**: The app is the user-friendly surface of the subsystem; making
pipeline state visible is its main value over hand-editing markdown.

**Independent Test**: With existing specs on disk, open the app and verify the tree
mirrors `specs/`, selecting a feature renders its spec, and per-phase status reflects
which artifacts exist.

**Acceptance Scenarios**:

1. **Given** specs exist on disk, **When** the user opens Build Studio, **Then** the left panel shows a tree matching the `specs/` structure.
2. **Given** a selected feature with spec/plan/tasks, **When** it is viewed, **Then** the main pane renders each artifact and a status indicator per pipeline phase.
3. **Given** a `tasks.md` with a checklist, **When** it is viewed, **Then** task completion/progress is shown.

---

### User Story 3 - Implement an agreed feature by delegating to the Developer (Priority: P2)

Once a feature has spec + plan + tasks, the user triggers implementation; Build Studio
delegates to the Developer (Claude) sub-agent with the spec context, surfaces live
progress, and afterward reflects the resulting status/drift.

**Why this priority**: Closes the loop from spec to code, but depends on the P1
authoring artifacts existing first.

**Independent Test**: For a feature with `tasks.md`, trigger implement; verify Build
Studio delegates to the Developer (never writes code itself) and streams events, and
that the app reflects updated status afterward.

**Acceptance Scenarios**:

1. **Given** a feature with `tasks.md`, **When** the user runs implement, **Then** Build Studio delegates to the Developer sub-agent with the spec/plan/tasks as context and does not write source itself.
2. **Given** implementation is running, **When** events stream, **Then** the app shows live progress.
3. **Given** implementation completes, **When** the feature is re-opened, **Then** status/drift reflects the new code state.

---

### User Story 4 - Detect spec ↔ code drift (Priority: P3)

A maintainer runs analyze/converge to check consistency across a feature's artifacts
and between the spec and the actual codebase; divergences are recorded in
`specs/discrepancies.md`.

**Why this priority**: Keeps specs authoritative over time; valuable but not required
for the first authoring loop.

**Independent Test**: Run converge on a feature whose code has drifted; verify
discrepancies are reported and recorded.

**Acceptance Scenarios**:

1. **Given** a feature, **When** the user runs analyze, **Then** cross-artifact inconsistencies are reported.
2. **Given** code has diverged from a spec, **When** the user runs converge, **Then** remaining work is appended to `tasks.md` and/or recorded in `specs/discrepancies.md`.

---

### Edge Cases

- When `specs/` is empty (fresh project), the app shows an empty state with actions to create the constitution and the first spec.
- A malformed or partial spec (missing template sections) is surfaced as a warning; pipeline phases that depend on missing artifacts are disabled.
- If the Developer harness is unavailable when implement is triggered, implement is blocked with a clear message; authoring still works.
- Concurrent edits to a spec from the app and from the agent — see FR-011 (the app's artifacts go read-only during a running pipeline step).
- Editing the constitution is allowed and treated like any spec artifact (via the constitution command).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: BOS MUST provide a "Build Studio" agent, selectable as the active assistant personality and usable as a sub-agent by the Default assistant.
- **FR-002**: The Build Studio agent MUST be a local sub-agent whose tools are limited to spec-scoped file operations plus the ability to delegate to other sub-agents; it MUST NOT have general repository write access.
- **FR-003**: Build Studio MUST be able to read, create, and modify specification artifacts confined to the `specs/` tree and the `.specify/` templates and constitution.
- **FR-004**: Build Studio MUST implement the spec-kit pipeline (constitution, specify, clarify, plan, tasks, analyze, implement, converge) using the vendored spec-kit templates and command methodology, delivered as skills. The `checklist` and `taskstoissues` commands are out of scope for v1.
- **FR-005**: Implementation steps MUST be delegated to the Developer (Claude) sub-agent; Build Studio MUST NOT write application or source code itself.
- **FR-006**: BOS MUST provide a "Build Studio" app with a left panel showing a navigable tree of `specs/` and a main pane visualizing the selected feature's artifacts and pipeline status.
- **FR-007**: The app MUST render spec artifacts (markdown) and show per-phase status and `tasks.md` progress.
- **FR-008**: When implementation runs, the app/assistant MUST stream live progress events (including events from the delegated Developer sub-agent).
- **FR-009**: Build Studio MUST keep specs and docs in sync per the constitution and record spec ↔ code drift in `specs/discrepancies.md`.
- **FR-010**: The spec tree and artifacts MUST be exposed to the client through a server route (the app is a client surface; spec files live server-side).
- **FR-011**: The app is a viewer and manual editor; while a pipeline step is running against a feature, that feature's artifacts MUST be read-only in the app. All writes MUST use atomic file writes; concurrent edits otherwise resolve last-write-wins (no locking service).
- **FR-012**: Build Studio MUST assign feature folder identifiers as auto-numbered `NNN-slug` (zero-padded 3-digit; next = max existing + 1; slug from the feature name; numeric suffix on collision), mirroring spec-kit.
- **FR-013**: Build Studio's behavior MUST be skill-driven — the agent prompt is minimal and a "Build Studio" skill (with per-command references) encodes the pipeline — so capabilities can be extended by adding skills (and any required tools/MCP, e.g. a future GitLab integration) without changing the agent or app code.

### Key Entities *(include if feature involves data)*

- **Specification (feature)**: a folder `specs/<NNN-feature>/` containing artifacts and a derived pipeline status.
- **Artifact**: a single spec-kit document (spec / plan / tasks / research / data-model / contracts) with a type and content.
- **Constitution**: the governing-principles document at `.specify/memory/constitution.md`.
- **Pipeline phase**: one of constitution / specify / clarify / plan / tasks / analyze / implement / converge, with a status derived from which artifacts exist and from code state.
- **Task**: an item in `tasks.md` with an id, description, dependency/order, and completion state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from a one-line feature idea to a complete, template-conformant `spec.md` in a single Build Studio session without hand-editing markdown.
- **SC-002**: The app's spec tree exactly mirrors the on-disk `specs/` structure (no missing or extra nodes).
- **SC-003**: For an agreed feature, generated `plan.md` and `tasks.md` pass `/speckit.analyze` consistency with no critical inconsistencies.
- **SC-004**: Implementation of a feature is always performed by the Developer sub-agent — zero instances of Build Studio writing source.
- **SC-005**: BOS's own outdated specs can be migrated into spec-kit format using Build Studio (dogfood): at minimum the load-bearing specs rewritten and validated.

## Assumptions

- The existing Developer (Claude) sub-agent and dev harness are available for implementation.
- spec-kit templates, command prompts, and scripts are vendored under `.specify/` (done in Phase 0).
- The repository adopts the spec-kit layout literally: `specs/<NNN-feature>/` + `.specify/`; the legacy `spec/` content is migrated and removed during dogfooding.
- Build Studio targets the spec lifecycle; building the Bare-Bone BOS (BBBOS) distribution is out of scope for this feature.
- Spec files are authoritative and stored in the BOS repository (they ship with the kernel), distinct from user app content (which lives in GitFS).
