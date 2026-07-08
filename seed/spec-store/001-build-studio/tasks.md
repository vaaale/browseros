---
description: "Task list for Build Studio (001-build-studio)"
---

# Tasks: Build Studio

**Input**: Design documents from `/specs/001-build-studio/`

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Included — BOS's constitution requires typecheck/lint and Playwright self-tests for promotable source changes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: the user story a task serves (US1–US4)

---

## Phase 1: Setup

- [ ] T001 Create the `bos/build-studio` feature branch (developer, via `git_branch`); confirm `.specify/` and `specs/001-build-studio/` are present.
- [ ] T002 [P] Add framework-free types in `src/lib/specs/types.ts` (`Specification`, `Artifact`, `PipelinePhase`, `PipelineStatus`, `Task`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ Blocks all user stories.**

- [ ] T003 Implement `src/lib/dev/spec-fs.ts` — `listDir/readFile/writeFile/editFile/search` jailed to `specs/` + `.specify/`, denying `..`/out-of-root escapes (mirror `repo-fs.ts`). Server-only.
- [ ] T004 Add `SPEC_TOOLS` (`list_specs/read_spec/write_spec/edit_spec/search_specs`) in `src/lib/agent/subagents/tools.ts`; include in `ALL_TOOLS`, exclude from default `SUBAGENT_TOOLS` (opt-in like `DEV_TOOLS`).
- [ ] T004a Add the `delegate_to_developer` tool so Build Studio can delegate `implement` whether active or nested: build it inside `runLocal` in `src/lib/agent/subagents/runner.ts` as a factory closed over the parent `onEvent` (forwarding nested Developer events to the per-agent nested UI) with a depth guard; it calls `runSubAgent(getSubAgent("developer"), …)`. Register the id in `tools.ts`/`ALL_TOOLS` (opt-in).
- [ ] T005 Implement `src/lib/specs/pipeline.ts` — derive per-feature phase status, parse `tasks.md` progress, and `nextFeatureId(name)` → `NNN-slug` numbering (zero-padded; max+1; suffix on collision).
- [ ] T006 Add `src/app/api/specs/route.ts` — `GET` tree+status, `GET ?path=` artifact, `PUT` artifact (atomic via spec-fs; read-only gate when a pipeline step is running).
- [ ] T007 Seed the Build Studio agent in `src/lib/agent/subagents/store.ts` `DEFAULTS` (local; `tools` = spec tools + `delegate_to_developer`; **thin** systemPrompt that points to the "Build Studio" skill) AND add an additive "ensure-exists by id" pass so existing installs receive it without clobbering edits.
- [ ] T008 Seed the "Build Studio" driver skill (dir `build-studio/`) in `src/lib/agent/skills/store.ts` `SEED` (`SKILL.md` triage + `references/` scaffold) AND an additive ensure-exists pass. This is the extensibility surface (FR-013).

**Checkpoint**: the agent can read/write specs via tools; the API serves the tree.

---

## Phase 3: User Story 1 — Author a feature spec through the pipeline (P1) 🎯 MVP

**Goal**: from a one-line idea, produce a template-conformant `spec.md` and run clarify → plan → tasks.

- [ ] T009 [P] [US1] Author skill references adapted from `.specify/templates/commands/{constitution,specify,clarify,plan,tasks}.md`, wired to `spec_*` tools and reading `.specify/templates/*.md`.
- [ ] T010 [US1] specify flow: create `specs/<NNN-slug>/spec.md` from `spec-template.md` using `nextFeatureId` (depends on T005, T009).
- [ ] T011 [US1] clarify flow: append `## Clarifications` / `### Session <date>` Q&A to `spec.md`.
- [ ] T012 [US1] plan/tasks flows: produce `plan.md` + `tasks.md` from templates, consistent with the constitution.

**Checkpoint**: Build Studio turns an idea into a conformant spec and can run clarify/plan/tasks.

---

## Phase 4: User Story 2 — Spec tree + pipeline visualization app (P1)

**Goal**: the Build Studio app shows a tree mirroring `specs/` and renders artifacts + status.

- [ ] T013 [US2] Add `src/apps/build-studio/manifest.ts` (id `build-studio`, name, Lucide icon).
- [ ] T014 [US2] Add `src/apps/build-studio/index.tsx` — left tree (GET `/api/specs`); main pane: artifact markdown (reuse BOS markdown renderer) + phase-status strip + tasks checklist/progress; empty state.
- [ ] T015 [P] [US2] Wire artifact editing via `PUT /api/specs` with the read-only-during-run gate and atomic save.
- [ ] T016 [US2] Run `npm run gen:apps`; verify auto-discovery and the desktop/dock icon.

**Checkpoint**: tree mirrors `specs/`; artifacts and per-phase status render.

---

## Phase 5: User Story 3 — Delegate implementation to the Developer (P2)

**Goal**: an agreed feature can be implemented by the Developer with live progress.

- [ ] T017 [US3] Add the implement reference (adapted from `.specify/templates/commands/implement.md`) instructing `delegate_to_developer` with spec/plan/tasks context (works whether Build Studio is the active personality or a nested sub-agent).
- [ ] T018 [US3] Wire Build Studio's triage so `implement` delegates to the Developer; surface a "working" indicator in the app reflecting the running step.

**Checkpoint**: implement delegates to the Developer; events stream in the assistant chat.

---

## Phase 6: User Story 4 — Spec ↔ code drift detection (P3)

**Goal**: analyze/converge report inconsistencies and record drift.

- [ ] T019 [P] [US4] Add analyze + converge references (adapted from the vendored commands) using `spec_*` tools.
- [ ] T020 [US4] Record drift in `specs/discrepancies.md` (create/update) and reflect it in pipeline status.

**Checkpoint**: analyze/converge report and record drift.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T021 [P] Docs: add `docs/usage/apps/build-studio.md` (end users) + `docs/dev/` coverage of the spec-kit subsystem (spec-fs jail, `/api/specs`, pipeline). (Constitution VI)
- [ ] T022 [P] Update `CLAUDE.md` to point at `.specify/memory/constitution.md` and the spec-kit workflow (note the legacy `spec/` migration is pending Phase 2).
- [ ] T023 [P] Tests: spec-fs jail unit test (path-escape denied; writes confined) + a Playwright e2e smoke for the app (tree renders, artifact opens). Get typecheck + lint + e2e green.
- [ ] T024 Re-run the Constitution Check and `/speckit.analyze` on `001-build-studio` (spec ↔ plan ↔ tasks consistency).

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → **Foundational (T003–T008, blocks everything)** → **US1 (T009–T012)** → **US2 (T013–T016)** → **US3 (T017–T018)** → **US4 (T019–T020)** → **Polish (T021–T024)**.
- US2 depends on T005 (status) + T006 (API). US3 depends on US1 artifacts existing. US4 depends on Foundational only.
- **Parallel**: `[P]` tasks touch different files — T002, T009, T015, T019, T021–T023 can overlap within their phase windows.

## Implementation Strategy

- **MVP** = Setup + Foundational + US1 + US2: a working authoring loop with a visual app. Stop and validate here.
- Then US3 (delegate-implement) closes the spec→code loop; US4 (drift) keeps specs authoritative.
- Build Studio itself is built by delegating these tasks to the Developer (Claude) sub-agent, on the `bos/build-studio` branch, per the constitution.

## Notes

- `[P]` = different files, no dependencies. `[Story]` maps a task to a user story for traceability.
- Verify the seed idempotency caveat (plan.md) — existing installs must receive the new agent + skill without clobbering user data.
- Commit after each logical group; keep changes reversible on the feature branch.
