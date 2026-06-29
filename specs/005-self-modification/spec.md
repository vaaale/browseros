# Feature Specification: Self-Modification (Live Version Control)

**Feature Branch**: `005-self-modification`

**Created**: 2026-06-28 (migrated from `spec/self-modification/self-modification.md`)

**Status**: Implemented

**Input**: "BOS can modify its own source safely by running a stable base version plus, on demand, one preview of a feature branch, so a self-modification never takes down the running instance and a preview can be previewed, promoted, or stopped."

> Migrated from `spec/self-modification/self-modification.md` (the control plane). Pairs with `006-data-isolation` (data plane), `008-self-testing` (verify stage), `007-gitfs` (content candidates), and `003-self-improvement` (what source change to make).
>
> **Revised** for the port-pool model: a single always-on **base** + at most one **preview** (replacing the fixed `active`/`next`/`previous` triple), branch-named worktrees, kill-on-switch, safe-ordering promote, and one-conversation-↔-one-branch continuity. **Rollback is a deferred capability** — every promote is still tagged as the durable anchor for it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A self-modification never bricks the running instance (Priority: P1)

A stable Supervisor builds the preview in an isolated git worktree on a pooled port; the **base** version keeps serving — including the conversation that requested the change.

**Acceptance Scenarios**:

1. **Given** the developer edits BOS source, **When** the change is applied, **Then** it lands in the preview's branch-named worktree and the running **base** version is unaffected.

### User Story 2 - Preview, then promote or stop (Priority: P1)

The user pins their session to the preview, tests it end-to-end at the same URL, then promotes (build-swap-then-tag) or stops it.

**Acceptance Scenarios**:

1. **Given** a `ready` preview, **When** the user pins their session to it, **Then** their requests route to it without moving global **base** or affecting other sessions.
2. **Given** a `ready` preview, **When** the user promotes, **Then** the new code is built + health-gated on the base port against canonical data **before** the base branch is advanced; only on success does the feature branch fast-forward into the base branch and an annotated tag get created; if it fails to come up, the previous base is restored and the base branch is left untouched.
3. **Given** a preview built by a delegated developer-agent fix (not via the branch dropdown), **When** the user opens the Topbar controls, **Then** the preview is NOT auto-served — the toolbar shows it is a preview and offers an explicit **Preview** (the user is still on **base** until they preview), so "the fix is in but the app is unchanged" cannot happen silently.
4. **Given** the base advanced under a `ready` preview (promote is not a fast-forward) and the preview rebases cleanly, **When** the user clicks Promote, **Then** the system rebases the preview onto base, **rebuilds and re-health-gates** it, then performs the swap.
5. **Given** a promote that cannot proceed (base checkout dirty, or the rebase would conflict), **When** the user clicks Promote, **Then** it fails with an actionable message surfaced in the UI naming the cause/conflicting files — never a silent no-op. (In-browser 3-way conflict resolution is a deferred capability.)

### User Story 3 - Continuity across a Stop (Priority: P1)

Stopping a preview kills + cleans it but **keeps its branch**; asking the assistant to keep improving "the thing we worked on" continues on the **same** feature branch (one conversation ↔ one branch; a currently-previewed branch wins).

**Acceptance Scenarios**:

1. **Given** a feature was worked on in a conversation and then Stopped, **When** the user asks the same conversation's assistant to improve it, **Then** the developer resumes the same feature branch rather than starting a new one.

### User Story 4 - An un-brickable escape hatch (Priority: P2)

The Supervisor serves a version-independent control page that works even if a BOS version's UI is broken.

### Edge Cases

- On-disk `data/` schema changes SHOULD stay backward-compatible (the deferred rollback runs prior code against the same data).
- Background jobs run on **base**, never on a preview.
- The Supervisor is off-limits to self-modification (updating it is a deliberate manual restart).
- A Supervisor restart drops in-memory preview state; the preview's **branch** survives and is re-selectable from the dropdown (boot reconciliation prunes the stale worktree).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The swap mechanism MUST live outside the swappable unit — a stable, minimal **Supervisor** (control plane) owns the public port, version registry, build/health, routing/preview, and promote/stop/drain; the developer sub-agent MUST NOT edit it. (Rollback is a deferred capability; promotes are tagged for it.)
- **FR-002**: A version MUST be a git worktree sharing one `.git`. There are two roles: **base** (a singleton, a detached worktree at the base commit, always on the base port) and at most one **preview** (a branch-named worktree on a pooled port). The base tree is immutable while a preview is built.
- **FR-003**: At begin, the Supervisor MUST deterministically (never LLM-driven) provision (or **resume**) the preview worktree, provision an isolated data clone, allocate a free pooled port, and point the dev harness working directory at it; the agent edits only the preview. Resume semantics: an existing feature branch is checked out with its history; absent, a fresh `bos/next-*` branch is created off base.
- **FR-004**: A preview MUST be an immutable production build in its own `.next` on its own pooled port, passing typecheck→lint→build→boot→health (`GET /api/health`); states `idle→building→ready | failed`; previewable at `ready`. A rebuild MUST stop the prior server first so it never collides on its port.
- **FR-005**: The Supervisor MUST reverse-proxy the public port to **base** by default; a per-session preview pin (`POST /__supervisor/pin`, session cookie) routes a session to the preview without moving base; preview is gated on health (a still-building, failed, or dead preview falls back to base). A preview provisioned by a delegated developer-agent run MUST NOT be auto-pinned. The Supervisor MUST report which version a session is being served (`serving` in `/__supervisor/state`). `GET /__supervisor/preview-changes` MUST report the preview's changed files (committed in its worktree) so an assistant's `gitStatus` is not fooled by a clean main checkout. `GET /__supervisor/branches` MUST list all branches so an orphaned preview is re-selectable.
- **FR-006**: The Supervisor MUST serve a version-independent control page at `/__supervisor` (plain HTML) that remains reachable when a BOS UI is broken (show state, Preview/Back to base, Promote, Stop, Push); the Topbar MUST surface convenient controls but the system MUST NOT depend on it alone. Topbar control failures MUST be surfaced to the user, never silently swallowed.
- **FR-007**: Promote MUST require a `ready` preview and a **clean base checkout**, failing early with an actionable, surfaced error otherwise. Promote uses **safe ordering**: (a) make the preview a clean descendant of base in its own worktree (fast-forward, else rebase + rebuild + re-health-gate, else surface conflicts); (b) stop the old base (awaiting exit), start the candidate's code on the base port against **canonical** data, and health-gate there — on failure, restore the previous base with the **base branch unmoved**; (c) only then fast-forward the base branch, create a mandatory annotated tag (`bos/v<yyyy-mm-dd-hh_mm_ss>`), push per `pushMode` (`manual` default | `auto-on-promote`), adopt the swapped server as base (detached off the now-merged branch, which is deleted). Promote is **code-only** (data clone discarded, canonical data carries forward).
- **FR-008**: *(Deferred.)* Rollback is not implemented in this revision. Every promote MUST leave an annotated tag so a future rollback can restore a prior version via the provision→build→swap pipeline without rewriting pushed history.
- **FR-009**: Stop MUST stop the preview (awaiting process exit), remove its worktree and data clone, and return the session to base; the preview's **branch is kept** (resumable). `stopProc` MUST await actual process exit so the base port can be safely rebound on promote.
- **FR-010**: On-disk `data/` schema changes SHOULD be backward-compatible; the Supervisor MUST be immutable to self-modification; background jobs run on **base**; the harness runs sandboxed. The Supervisor MUST pass `BOS_CANONICAL_DATA` to every version so cross-version state (the conversation→branch map) persists to canonical data even from a preview's clone.
- **FR-011**: A `self-modification` config namespace MUST expose public/base ports, preview pool size, worktrees location, base branch, `pushMode` + remote, tag scheme, and build/health timeouts; a **Versions** view lists base + preview state with Preview/Promote/Stop/Push.

### Key Entities

- **Supervisor** — stable control plane (proxy + lifecycle).
- **Base** — the singleton running promoted version, always on the base port.
- **Preview** — at most one feature-branch version on a pooled port, with a state machine (idle→building→ready|failed).
- **Git tag** — durable ordered record of every promote (anchor for the deferred rollback).
- **Preview pin** — per-session routing override.
- **Conversation→branch map** — durable (canonical-data) anchor making one conversation continue on one feature branch.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A self-modification never interrupts the running instance or the conversation that triggered it.
- **SC-002**: A preview is reachable for preview without moving global **base**.
- **SC-003**: Every promote is tagged (the durable record for the deferred rollback) and a failed promote leaves base serving the prior code with the base branch unmoved.
- **SC-004**: The Supervisor control page stays usable when a BOS version's UI is broken.

## Notes

- Data plane: `006-data-isolation`. Verify stage: `008-self-testing`. Content candidates: `007-gitfs`. What-to-change: `003-self-improvement`. Developer/harness + feature-branch rule: the constitution.
- Faithful migration of `spec/self-modification/self-modification.md`; original prose remains in git history.
- Rollback (User Story "every change is reversible" in the original) is **deferred**; the user has a separate rollback design to add later. Tags are retained now so it can be built without losing history.
