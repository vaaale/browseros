# Feature Specification: Self-Modification (Live Version Control)

**Feature Branch**: `005-self-modification`

**Created**: 2026-06-28 (migrated from `spec/self-modification/self-modification.md`)

**Status**: Implemented

**Input**: "BOS can modify its own source safely by running a stable base version plus, on demand, branch-owned previews, so a self-modification never takes down the running instance and a preview can be previewed, promoted, stopped, or discarded."

> Migrated from `spec/self-modification/self-modification.md` (the control plane). Pairs with `006-data-isolation` (data plane), `008-self-testing` (verify stage), `007-gitfs` (content candidates), and `003-self-improvement` (what source change to make).
>
> **Revised** for the branch-owned port-pool model: a single always-on **base** plus
> multiple branch-owned **previews** (only one preview is viewed by a browser
> session at a time), branch-named worktrees, safe-ordering promote, explicit active
> feature branch ownership for developer harness work, and restart recovery from
> `bos/*` git branches. **Rollback is a deferred capability** — every promote is
> still tagged as the durable anchor for it.

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

### User Story 3 - Explicit feature-branch ownership (Priority: P1)

Stopping a preview kills its server but keeps its worktree, data clone, and branch;
asking to keep improving a feature continues on the conversation's explicit
**Active feature branch**. Developer harness work is never allowed to infer a branch
from the currently viewed preview.

**Acceptance Scenarios**:

1. **Given** a conversation has an Active feature branch, **When** it delegates to the developer, **Then** the developer harness edits that branch's isolated worktree.
2. **Given** no Active feature branch is selected, **When** an agent tries to invoke the developer harness for BOS source edits, **Then** the harness fails before spawning Claude/OpenCode/MCP and tells the agent to select/create a feature branch.
3. **Given** multiple previews are built/running, **When** the user wants the Assistant to improve one branch while viewing another version, **Then** the Assistant app's Active feature branch selector determines the branch passed to the harness.
4. **Given** a feature branch was stopped and BOS restarted, **When** the Supervisor starts, **Then** it recovers the `bos/*` branch as a `not-built` preview rather than relying on persisted runtime state.

### User Story 4 - An un-brickable escape hatch (Priority: P2)

The Supervisor serves a version-independent control page that works even if a BOS version's UI is broken.

### Edge Cases

- On-disk `data/` schema changes SHOULD stay backward-compatible (the deferred rollback runs prior code against the same data).
- Background jobs run on **base**, never on a preview.
- The Supervisor is off-limits to self-modification (updating it is a deliberate manual restart).
- A Supervisor restart drops in-memory preview state; `bos/*` branches survive and are re-selectable from the dropdown as `not-built` previews (boot reconciliation prunes stale worktrees).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The swap mechanism MUST live outside the swappable unit — a stable, minimal **Supervisor** (control plane) owns the public port, version registry, build/health, routing/preview, and promote/stop/drain; the developer sub-agent MUST NOT edit it. (Rollback is a deferred capability; promotes are tagged for it.)
- **FR-002**: A version MUST be a git worktree sharing one `.git`. There are two roles: **base** (a singleton, a detached worktree at the base commit, always on the base port) and **preview** (zero or more branch-named worktrees on pooled ports). The base tree is immutable while previews are built.
- **FR-003**: At begin, the Supervisor MUST deterministically (never LLM-driven) provision (or **resume**) the preview worktree, provision an isolated data clone, allocate a free pooled port, and point the dev harness working directory at it; the agent edits only the preview. The branch argument is mandatory and MUST match `bos/<kebab-name>` with one to four lowercase dash-separated segments. An existing feature branch is checked out with its history; absent, that explicit branch is created off base.
- **FR-004**: A preview MUST be an immutable production build in its own `.next` on its own pooled port, passing typecheck→lint→build→boot→health (`GET /api/health`); states `idle→building→ready | failed`; previewable at `ready`. A rebuild MUST stop the prior server first so it never collides on its port.
- **FR-005**: The Supervisor MUST reverse-proxy the public port to **base** by default; a per-session preview pin (`POST /__supervisor/pin`, session cookie) routes a session to the preview without moving base; preview is gated on health (a still-building, failed, or dead preview falls back to base). A preview provisioned by a delegated developer-agent run MUST NOT be auto-pinned. The Supervisor MUST report which version a session is being served (`serving` in `/__supervisor/state`). `GET /__supervisor/preview-changes` MUST report the preview's changed files (committed in its worktree) so an assistant's `gitStatus` is not fooled by a clean main checkout. `GET /__supervisor/branches` MUST list all branches so an orphaned preview is re-selectable.
- **FR-006**: The Supervisor MUST serve a version-independent control page at `/__supervisor` (plain HTML) that remains reachable when a BOS UI is broken (show state, Preview/Back to base, Promote, Stop, Discard, Push); the Topbar MUST surface convenient controls but the system MUST NOT depend on it alone. The Topbar MUST show a prominent centered BASE/PREVIEW marker, list actual git branch names in its dropdown, show build/start status immediately after selection, expose Stop/Discard/Promote/Retry according to preview state, and include a Supervisor Log viewer. Topbar control failures MUST be surfaced to the user, never silently swallowed.
- **FR-007**: Promote MUST require a `ready` preview and a **clean base checkout**, failing early with an actionable, surfaced error otherwise. Promote uses **safe ordering**: (a) make the preview a clean descendant of base in its own worktree (fast-forward, else rebase + rebuild + re-health-gate, else surface conflicts); (b) stop the old base (awaiting exit), start the candidate's code on the base port against **canonical** data, and health-gate there — on failure, restore the previous base with the **base branch unmoved**; (c) only then fast-forward the base branch, create a mandatory annotated tag (`bos/v<yyyy-mm-dd-hh_mm_ss>`), push per `pushMode` (`manual` default | `auto-on-promote`), adopt the swapped server as base (detached off the now-merged branch, which is deleted). Promote is **code-only** (data clone discarded, canonical data carries forward).
- **FR-008**: *(Deferred.)* Rollback is not implemented in this revision. Every promote MUST leave an annotated tag so a future rollback can restore a prior version via the provision→build→swap pipeline without rewriting pushed history.
- **FR-009**: Stop MUST stop the preview server (awaiting process exit), keep its worktree/data clone/branch, and return the session to base. Discard MUST stop the preview, remove its worktree and data clone, delete the feature branch, and return the session to base. `stopProc` MUST await actual process exit so the base port can be safely rebound on promote.
- **FR-010**: On-disk `data/` schema changes SHOULD be backward-compatible; the Supervisor MUST be immutable to self-modification; background jobs run on **base**; the harness runs sandboxed. The Supervisor MUST pass `BOS_CANONICAL_DATA` to every version so code running from a preview can locate canonical runtime data when needed.
- **FR-011**: A `self-modification` config namespace MUST expose public/base ports, preview pool size, worktrees location, base branch, `pushMode` + remote, tag scheme, and build/health timeouts; a **Versions** view lists base + preview state with Preview/Promote/Stop/Push.
- **FR-012**: Developer harness source edits MUST require a validated explicit feature branch. Assistant conversations MUST persist an optional `activeFeatureBranch`, and the Assistant app MUST expose an Active feature branch dropdown with existing feature branches plus a New feature branch action. The public LLM tool schema MUST NOT expose branch selection as a tool parameter; server routes resolve it deterministically from conversation/workflow state. If no valid branch resolves, the harness MUST fail before spawning Claude/OpenCode/MCP.
- **FR-013**: On Supervisor startup, runtime preview state MUST be reconstructed from git branches rather than persisted state. Existing `bos/*` branches MUST be treated as `not-built` even if worktrees existed before restart.

### Key Entities

- **Supervisor** — stable control plane (proxy + lifecycle).
- **Base** — the singleton running promoted version, always on the base port.
- **Preview** — a branch-owned feature version on a pooled port, with a state machine (`not-built`/`idle`→`building`→`ready`|`failed`, plus `stopped`).
- **Git tag** — durable ordered record of every promote (anchor for the deferred rollback).
- **Preview pin** — per-session routing override.
- **Active feature branch** — per-conversation `bos/<kebab-name>` selection that owns developer harness source edits.

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
