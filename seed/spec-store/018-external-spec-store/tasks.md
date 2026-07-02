---
description: "Task list for External Spec Stores (018-external-spec-store)"
---

# Tasks: External Spec Stores (System + User)

**Input**: Design documents from `/specs/018-external-spec-store/`

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Included — BOS's constitution requires typecheck/lint and Playwright self-tests for promotable source changes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: the user story a task serves (US1–US6)

---

## Phase 1: Setup

- [ ] T001 Create the `bos/external-spec-store` feature branch (developer, via `git_branch`); confirm `.specify/templates` + scripts (the spec-kit engine) stay tracked and `specs/018-external-spec-store/` is present.
- [ ] T002 [P] Add `src/os/specs-dir.ts` — `specsRoot()` from `BOS_SPECS_ROOT` (default `<cwd>/specs`), mirroring `apps-dir.ts`; the root is a plain container, never a git repo.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ Blocks all user stories.**

- [ ] T003 Implement `src/lib/specs/stores.ts` — `StoreManifest` type + discovery: list `specsRoot()`, a subdir is a store iff it has BOTH `<subdir>/.git` (via `fs.access`, never `git rev-parse` — the `007-gitfs` guard) AND a `spec-store.json` manifest; return the active-store set `{ id, label, root, owner, writable, requiresPromote }`; ignore subdirs missing either. No central registry.
- [ ] T004 Refactor `src/lib/dev/spec-fs.ts` to **multi-root**: resolve `(storeId, relPath)` against the active-store set; keep per-store jail (path-escape refusal, size caps, text search); reads span all stores; a write where `writable === false` is refused; a write where `requiresPromote === true` is routed to the candidate branch (T005), not straight to `main`.
- [ ] T005 Implement `src/lib/specs/store-git.ts` — reuse `src/lib/gitfs/store.ts` (`ensureRepo`/`commitAll`/`history`) per store; `commitOnSave` (user store), `beginCandidate`/`promoteCandidate`/`discardCandidate` (system store, **build-free `git merge`**, mirror `appBegin/appPromote/appDiscard`). Server-side only — the Supervisor is NOT involved (no build/preview/port).
- [ ] T006 Implement `src/lib/specs/seed.ts` — `ensureSystemStore()`: if the system-store subdir is absent, `git init` + copy the seed bundle + write its `spec-store.json` (`owner:system, writable:true, requiresPromote:true`) + initial commit; if present, apply **additive ensure-exists** (add missing spec paths, never clobber locally edited system specs). Auto-create an empty user store (`owner:user, writable:true, requiresPromote:false`) if absent.

**Checkpoint**: stores are discovered; spec-fs resolves per store; seeding materializes the system + user stores.

---

## Phase 3: User Story 1 — Specs never collide with BOS upstream (P1) 🎯 MVP

**Goal**: specs live in independent repos under `BOS_SPECS_ROOT`; the BOS working tree contains no spec files.

- [ ] T007 [US1] Build the tracked seed bundle `seed/spec-store/` from the current `specs/` (all `NNN-*`, `overview.md`, `discrepancies.md`) + `.specify/memory/constitution.md`, plus the system `spec-store.json`.
- [ ] T008 [US1] Migrate tracking: `git rm -r specs/` and `git rm .specify/memory/constitution.md`; add the `BOS_SPECS_ROOT` default path (`/specs`) to `.gitignore`; keep `.specify/templates` + scripts tracked.
- [ ] T009 [US1] Repoint `src/lib/dev/repo-fs.ts` — remove `specs/` + `.specify/memory/` from `WRITE_ALLOW_PREFIXES` (specs are no longer repo-fs territory).
- [ ] T010 [P] [US1] Unit test: store discovery + manifest parse (subdir with `.git`+manifest = store; missing either = ignored) and multi-root spec-fs jail (path escape denied; write to a non-`writable` store refused).

**Checkpoint**: a `git pull` on BOS source cannot conflict with spec content; the BOS working tree shows no spec files.

---

## Phase 4: User Story 2 — Work on specs from the normal Build Studio (P1)

**Goal**: create/edit a spec in place from the running BS session — no preview, no build, no dev round-trip.

- [ ] T011 [US2] Extend `src/app/api/specs/route.ts` `PUT` to write via multi-root spec-fs and persist (commit-on-save for the user store) so an edit is durable and immediately visible in the same session.
- [ ] T012 [P] [US2] Test: author + edit a user spec via the API, reload, confirm content persists (committed) with no promote and zero build steps.

**Checkpoint**: user-store edits persist and are visible immediately in-session.

---

## Phase 5: User Story 3 — Build Studio shows System and User as groups (P1)

**Goal**: the BS tree renders one group per store, discovery-driven.

- [ ] T013 [US3] Extend `GET /api/specs` to return the active stores as **groups**, each with its spec tree + per-feature pipeline status (add a `store` dimension to reads/writes).
- [ ] T014 [US3] Update `src/apps/build-studio/index.tsx` — render one group per store (label from the manifest, fallback dir name); new stores appear automatically from discovery.
- [ ] T015 [P] [US3] e2e: both System and User groups render with their specs; a store repo cloned into the root appears as a new group with no code change.

**Checkpoint**: BS shows System + User groups; specs are served from their stores.

---

## Phase 6: User Story 4 — System specs editable, versioned via promote (P2)

**Goal**: system-spec changes land on a candidate branch and promote via a build-free merge.

- [ ] T016 [US4] Add `POST /api/specs/promote` and `POST /api/specs/discard` `{store}` in `src/app/api/specs/route.ts`, wired to `store-git` `promoteCandidate`/`discardCandidate`; a change touching the constitution requires explicit user confirmation before promote.
- [ ] T017 [US4] BS UI: promote/discard controls for stores where `requiresPromote` is true; a confirmation prompt for constitution changes.
- [ ] T018 [P] [US4] e2e: edit a system spec → it lands on `spec-candidate` → promote → merged to `main` with NO `npm run build` invoked and NO preview server started.

**Checkpoint**: system specs stay editable and are gated behind a build-free promote.

---

## Phase 7: User Story 5 — The developer can read the spec it implements (P2)

**Goal**: at implement time the target store(s) are readable in the worktree at the natural `specs/<store>/…` path.

- [ ] T019 [US5] `tools/supervisor/supervisor.mjs`: at `begin`, mount the requested store(s) into the worktree at `specs/<storeId>/` (reflink→copy, reusing the `hydrateWorktree` discipline); re-sync on worktree reuse. No env var, no `.git/info/exclude` — the BOS repo's gitignore of `specs/` (T008) auto-excludes the mount from the candidate `git add -A`.
- [ ] T020 [US5] `src/lib/agent/subagents/claude-runner.ts`: request the mount for the store containing the target spec + the system store (constitution); the delegation task references the explicit `specs/<store>/…` path.
- [ ] T021 [US5] Update the developer skill to read reference specs/constitution at `specs/<store>/…` (explicit paths, no env indirection).
- [ ] T022 [P] [US5] Test: a delegated implement reads its spec at `specs/<store>/…`; the mounted copy is absent from the candidate commit (git status excludes it); a harness edit to the copy never reaches the store.

**Checkpoint**: the harness reads the spec it implements without spec content leaking onto the code branch.

---

## Phase 8: User Story 6 — Additional spec marketplaces plug in (P3)

**Goal**: a cloned store repo under the root is auto-discovered as a new group.

- [ ] T023 [US6] Confirm discovery + `/api/specs` treat any store repo cloned under `BOS_SPECS_ROOT` as a group (no config, no code change); document the `spec-store.json` manifest contract for third-party/marketplace stores.

**Checkpoint**: marketplaces are a drop-in (git clone → new group).

---

## Phase 9: Polish & Cross-Cutting

- [ ] T024 [P] Docs (Constitution VI): update `docs/dev/repository-and-data-layout.md` (spec stores), `docs/dev/api-reference.md` (`/api/specs` store dimension + promote/discard), `docs/dev/build-studio.md`, and `docs/usage` Build Studio pages.
- [ ] T025 [P] Update `CLAUDE.md`: specs now live in external stores under `BOS_SPECS_ROOT` (system + user), discovered as self-describing folders; the spec-kit engine stays in `.specify/templates`; repoint the "specs live under `specs/`" guidance.
- [ ] T026 [P] Get typecheck + lint + Playwright e2e green (BS two-group tree; build-free promote; harness read-only mount).
- [ ] T027 Re-run the Constitution Check and `/speckit.analyze` on `018` (spec ↔ plan ↔ tasks); the 018 spec migrates into the system store as part of the seed bundle (the last spec authored in-tree).

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → **Foundational (T003–T006, blocks everything)** → **US1 (T007–T010)** → **US2 (T011–T012)** → **US3 (T013–T015)** → **US4 (T016–T018)** → **US5 (T019–T022)** → **US6 (T023)** → **Polish (T024–T027)**.
- T006 (seed) needs the bundle; unit-test it with a fixture, but the real bundle (T007) plus the tracking migration (T008) land in US1. US3 depends on T013 (store dimension). US4 depends on T005 (candidate/promote). US5 depends on T008 (the gitignore that makes the mount safe).
- **Parallel**: `[P]` tasks touch different files — T002, T010, T012, T015, T018, T022, T024–T026 can overlap within their phase windows.

## Implementation Strategy

- **MVP** = Setup + Foundational + US1 + US2 + US3: specs live in external stores, editable in place from BS, shown as System/User groups. Stop and validate here.
- Then US4 (versioned system-spec promote) and US5 (harness read-only mount) close the authoring→implement loop; US6 (marketplaces) is a drop-in the design already supports.
- 018 itself is built by delegating these tasks to the Developer (Claude) on `bos/external-spec-store`, per the constitution.

## Notes

- `[P]` = different files, no dependencies. `[Story]` maps a task to a user story for traceability.
- Watch the seed idempotency caveat (plan.md): additive ensure-exists must add new system specs on BOS updates without clobbering locally edited ones.
- The container root is never a git repo; each store is; detect via `<store>/.git` (never `git rev-parse`).
- Commit after each logical group; keep changes reversible on the feature branch.
