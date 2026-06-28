# Feature Specification: Self-Modification (Live Version Control)

**Feature Branch**: `005-self-modification`

**Created**: 2026-06-28 (migrated from `spec/self-modification/self-modification.md`)

**Status**: Implemented

**Input**: "BOS can modify its own source safely by running multiple versions of itself concurrently, so a self-modification never takes down the running instance and a candidate can be previewed, promoted, rolled back, or discarded."

> Migrated from `spec/self-modification/self-modification.md` (the control plane). Pairs with `006-data-isolation` (data plane), `008-self-testing` (verify stage), `007-gitfs` (content candidates), and `003-self-improvement` (what source change to make).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A self-modification never bricks the running instance (Priority: P1)

A stable Supervisor builds the candidate in an isolated git worktree on its own port; the live version keeps serving — including the conversation that requested the change.

**Acceptance Scenarios**:

1. **Given** the developer edits BOS source, **When** the change is applied, **Then** it lands in the `next` worktree and the running `active` version is unaffected.

### User Story 2 - Preview, then promote or discard (Priority: P1)

The user pins their session to a candidate, tests it end-to-end at the same URL, then promotes (flip + tag) or discards it.

**Acceptance Scenarios**:

1. **Given** a `ready` candidate, **When** the user pins their session to it, **Then** their requests route to it without moving global `active` or affecting other sessions.
2. **Given** a `verified` candidate, **When** the user promotes, **Then** the feature branch fast-forwards into the base branch, an annotated tag is created, and routing flips with drain.

### User Story 3 - Every change is reversible (Priority: P1)

Rollback restores a prior version — instantly to `previous`, or to any earlier tag via the same provision→validate→flip pipeline.

### User Story 4 - An un-brickable escape hatch (Priority: P2)

The Supervisor serves a version-independent control page that works even if a BOS version's UI is broken.

### Edge Cases

- On-disk `data/` schema changes MUST stay backward-compatible (a rollback to prior code must still read the store).
- Background jobs run on `active`, never on a preview.
- The Supervisor is off-limits to self-modification (updating it is a deliberate manual restart).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The swap mechanism MUST live outside the swappable unit — a stable, minimal **Supervisor** (control plane) owns the public port, version registry, build/health, routing/preview, and promote/rollback/discard/drain; the developer sub-agent MUST NOT edit it.
- **FR-002**: A version MUST be a git worktree sharing one `.git`, with roles `active` / `next` / `previous`; the running tree is immutable while a candidate is built.
- **FR-003**: At begin, the Supervisor MUST deterministically (never LLM-driven) ensure the `next` worktree on a fresh feature branch reset to `active`'s HEAD, provision an isolated data clone, and point the dev harness working directory at `next`; the agent edits only `next`.
- **FR-004**: A candidate MUST be an immutable production build in its own `.next` on its own port, passing typecheck→lint→build→boot→health (`GET /api/health`)→e2e; states `building→ready→testing→verified | failed | tests-failed`; previewable at `ready`, promotable when `verified` (or user override of `tests-failed`).
- **FR-005**: The Supervisor MUST reverse-proxy the public port to `active` by default; a per-session preview pin (`POST /__supervisor/pin`, session cookie) routes a session to another version without moving `active`; preview is gated on health; a previewed candidate uses an isolated data clone.
- **FR-006**: The Supervisor MUST serve a version-independent control page at `/__supervisor` (plain HTML) that remains reachable when a BOS UI is broken (show state, pin/clear, rollback, push to remote); the Topbar MUST surface convenient controls (Preview/Back/Promote/Push/Discard) but the system MUST NOT depend on it alone.
- **FR-007**: Promote MUST require a `verified` candidate (or override), then fast-forward the feature branch into the base branch `active` tracks, re-anchor `active`, record `previous`, create a mandatory annotated tag (`bos/v<N>`), push per `pushMode` (`manual` default | `auto-on-promote`; manual push always available), and flip routing with drain; promote is **code-only** (data clone discarded, base carries forward).
- **FR-008**: Rollback MUST restore a prior version via the same provision→validate→flip pipeline — instant to `previous`, or to any earlier tag (re-provision + gate); it MUST NOT rewrite pushed history (append-only revert/re-promote).
- **FR-009**: Discard MUST stop `next`, reset/remove its worktree, and delete its data clone; **drain** MUST keep a version losing traffic alive until in-flight requests finish (notably the streaming chat that triggered the change).
- **FR-010**: On-disk `data/` schema changes MUST be backward-compatible; the Supervisor MUST be immutable to self-modification; background jobs run on `active`; the harness runs sandboxed.
- **FR-011**: A `self-modification` config namespace MUST expose public/internal ports, worktrees location, base branch, `pushMode` + remote, tag scheme, retain-`previous`, and build/health timeouts; a **Versions** view lists versions/state/logs/tags with promote/rollback/discard/push and e2e results.

### Key Entities

- **Supervisor** — stable control plane (proxy + lifecycle).
- **BOS version** — a worktree instance (active/next/previous) on its own port + `.next` + data root.
- **Candidate** — a `next` version with a state machine (building→…→verified).
- **Git tag** — durable ordered record of every promote (rollback target).
- **Preview pin** — per-session routing override.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A self-modification never interrupts the running instance or the conversation that triggered it.
- **SC-002**: A candidate is reachable for preview without moving global `active`.
- **SC-003**: Every promote is tagged and reversible (rollback to `previous` or any tag).
- **SC-004**: The Supervisor control page stays usable when a BOS version's UI is broken.

## Notes

- Data plane: `006-data-isolation`. Verify stage: `008-self-testing`. Content candidates: `007-gitfs`. What-to-change: `003-self-improvement`. Developer/harness + feature-branch rule: the constitution.
- Faithful migration of `spec/self-modification/self-modification.md`; original prose remains in git history.
