# Feature Specification: User-Spec Relocation — VFS Mount Points, SpecFS, Feature Context, Spec Provider Registry

**Feature Branch**: `027-vfs-specfs-marketplace` (relocation scope; marketplace + app sandbox split to `028-marketplace-sandbox`)

**Created**: 2026-07-15

**Status**: Draft (revised after two design-review passes — see `spec-review.md`, `spec-review-v2.md`)

**Input**: "Relocate user-specs into the user's VFS (Documents/Specs/) so any app or agent can write to them via standard VFS file operations — not just through the spec-write tool. The git repo must survive a full VFS wipe. BOS should provide an internal service (no GitHub required). Introduce a general VFS mount-point abstraction, a SpecFS backend with auto-branching and LLM-generated commits, a Feature Context correlating branches across repos, and a Provider Registry for pluggable spec discovery."

> Scope note (review v2, N4): this spec is the **shippable user-specs relocation**. The Marketplace, three-source app model, opaque-origin sandbox, and iframe-SDK-as-library work moved to **`028-marketplace-sandbox`**, which depends on this feature. Splitting keeps the P1 relocation out of a 7-phase mega-feature.
>
> This supersedes **018-external-spec-store FR-005/FR-007** (global branch and symlink mount) and builds on the **already-implemented** branch-coupled worktree model of **020-branch-coupled-specs** — it *adopts* that engine rather than replacing it.

## Why this exists (context)

Two converging problems:

**1. Specs are siloed behind a single tool.** The only way to write to a spec is the `spec-write` server tool. Any app that wants to deposit an artifact into a spec — the UI Preview designer writing a mockup, an agent generating a schema — must go through that one tool. Real operating systems don't have this problem: `open()`/`read()`/`write()` work the same regardless of the underlying filesystem. BOS's VFS should too.

**2. User-specs live in the wrong place.** `BOS_SPECS_ROOT` points into the source clone — not the per-user data volume. A VFS wipe or container rebuild risks losing specs. User-specs must live somewhere (a) per-user, (b) protected from VFS wipes, and (c) reachable through standard VFS operations.

The solution treats the VFS the way a real OS treats its filesystem: a uniform interface backed by pluggable providers, layered on top of the branch-coupled git engine that already exists.

## Ownership split (decided in review — foundational)

- **User specs** (`data/specs/user/`) are edited through the VFS/SpecFS fast path, branch-coupled to a Feature Context, promoted spec-only without a rebuild. This is the "internal service" — no GitHub required.
- **System specs** (`bos-system-specs`) are **read-only at runtime**, mirrored from the source tree (`seed/spec-store/`) on each boot. Editing a system spec is a *source* change: it flows through the Developer agent on the same `bos/feat/<id>` branch as code and promotes via PR + rebuild. There is no writable system store at runtime. This collapses the old "writable system store" special case and aligns system-spec authoring with "always delegate; Claude codes."

## Branch model (adopts 020, does not replace it)

SpecFS is an **adapter over the existing `src/lib/dev/spec-fs.ts` + Supervisor worktree engine**, not a new git engine:
- **No `git checkout`** of any base tree. Ever.
- **Reads are ref-pinned** (`git show <ref>:path`, via the existing `readFileAtBranch`), never dependent on mutable working-tree state.
- **Writes on an active feature branch go to a worktree**: the Supervisor-provisioned worktree when a code preview exists (source-inclusive feature), or a SpecFS-self-provisioned worktree when there is no preview (spec-only feature).
- **Worktree precedence (review v2, N1):** the Supervisor worktree is always preferred. If a feature that began spec-only (SpecFS self-provisioned a worktree) later becomes source-inclusive, SpecFS **flushes and prunes its self-provisioned worktree** before the Supervisor adds its own for the same branch. Safe because commits live on the branch ref, not the worktree — pruning loses nothing.
- **Promote** flushes pending writes, reconciles `main` into the feature branch (conflicts resolved on the branch), fast-forwards `main`, and prunes the worktree.

## Clarifications

### Session 2026-07-15 (initial design)

- Q: Where should user-specs live? → A: Inside the VFS at `Documents/Specs/`, backed by `data/specs/user/` (outside `data/vfs/`, surviving a VFS wipe). A mount point routes the path to SpecFS.
- Q: When should a git commit happen? → A: Debounced flush (2 s) on the write side, coalescing rapid writes; async, never blocks the caller.
- Q: How is the commit message generated? → A: LLM call over the (bounded) diff, with a deterministic fallback on any error.
- Q: What is the branch for a multi-spec feature? → A: The Feature Context's `bos/feat/<id>`, shared across all touched specs and BOS source.
- Q: Is a Feature Context required for every write? → A: Always. No implicit/anonymous context.
- Q: Keep `BOS_SPECS_ROOT`? → A: No — convention over configuration. Fixed paths under `dataDir()`.

### Session 2026-07-15 (design review resolutions)

- Q: What is the write path to system specs? → A: **None at runtime (Option B).** System specs are read-only, mirrored from source; edits go through the Developer agent as source changes.
- Q: How does SpecFS's branch model coexist with the Supervisor's worktree model (020)? → A: **It adopts it.** No checkout, ref-pinned reads, worktree writes (Supervisor's preferred; self-provisioned fallback pruned on hand-off), promote reconciles into `main`. The Supervisor's `BOS_SPECS_ROOT` reads are *repointed* to the fixed layout (bounded), not rewritten.
- Q: How is a Feature Context created (so always-require isn't a dead end)? → A: See the 2026-07-15 (redesign) note below — the feature is per **conversation**, and apps inherit or select a feature branch.
- Q: How does the read-only system store stay current across releases? → A: **Mirror, not merge.** `data/specs/system/` is overwritten/pruned from `seed/spec-store/` on each boot (not additive `copyMissing`), so system-spec changes shipped in a release reach existing users. Scoped to the system store only; the user store is untouched.
- Q: What happens on a promote merge conflict? → A: A first-class result. Promote reconciles `main` into the feature branch; on conflict it aborts and returns `{ kind: 'conflict', files }` for resolution on the branch. `main` only ever fast-forwards.
- Q: Debounce-vs-promote race and crashes? → A: Promote force-flushes pending writes first. Startup sweeps any uncommitted worktree state into a recovery commit. No silent data loss.
- Q: Concurrent contexts / multiple tabs? → A: See the redesign note — the feature is scoped per conversation, so conversations/tabs each carry their own active feature branch (no global pointer to keep in sync).

### Session 2026-07-15 (redesign: per-conversation feature scope)

The active feature is **per conversation**, not a single global per-instance context — matching the existing 020 model where each conversation persists an `activeFeatureBranch` (`Documents/Chats/<id>.json`). There are good reasons to keep it that way (parallel features across conversations, no global contention). The earlier global `feature-context.json` + `setActive`/`clear` API route + OS-store mirror were removed.

- **Source of truth**: the conversation's `activeFeatureBranch` (convention `bos/<kebab>`, validated by `src/lib/agent/feature-branch.ts`).
- **Resolution**: a VFS write (`vfs.writeText('Documents/Specs/…')`) has no conversation argument, so the current conversation/branch is carried in a **request-scoped AsyncLocalStorage feature scope** (`withFeatureScope`, mirroring `logging/context.ts`). SpecFS resolves via `getActiveBranch()`: an explicit `scope.branch` wins, else `scope.conversationId` → the conversation's `activeFeatureBranch`, else none (writes throw `SpecFSNoContextError`).
- **App association (option b)**: an app operates *within* a feature/conversation context it inherits (its window/requests carry the conversation or branch). Apps launched **without** a conversation MUST provide UI to select or create a feature branch, which seeds the scope for their writes.
- **Promote** takes the branch explicitly; spec-only vs source-inclusive is derived from git (a same-named branch in the BOS source repo), not a tracked `touchedSourcePaths` list.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Any app can write to a user spec (Priority: P1)

A running app calls `vfs.writeText('Documents/Specs/95-myapp/ui-mockup.json', content)` with no git knowledge. With an active Feature Context, the file lands on the feature branch's worktree and a commit is generated automatically.

**Independent Test**: Set a feature context; from a server route call `vfs.writeText('Documents/Specs/test/file.json', '{}')`. Confirm the file is on the feature worktree, `git log` shows a commit on `bos/feat/<id>`, and no git API is visible to the caller.

**Acceptance Scenarios**:
1. **Given** an active feature context, **When** `vfs.writeText('Documents/Specs/…')` is called, **Then** the file is written to the branch's worktree and a debounced commit is scheduled.
2. **Given** no active feature context, **When** the same call is made, **Then** a `SpecFSNoContextError` is thrown with guidance to create one (no silent commit to a default branch).
3. **Given** five rapid writes within 2 s, **When** the window closes, **Then** exactly one commit contains all five changes.
4. **Given** a commit is generated, **When** the LLM call fails or the diff is oversized, **Then** the commit still happens with the bounded/fallback message (no write lost).

### User Story 2 — A feature spans multiple specs and correlates with source (Priority: P1)

A developer starts feature "backend-with-ui" touching specs `040` and `041`. Both land on `bos/feat/backend-with-ui`. When the Developer agent implements it, it works on the same branch in BOS source **via the Supervisor** (never a raw checkout of the running tree).

**Independent Test**: Set context `{ id: "backend-with-ui" }`. Write to two spec folders; confirm both commits share the branch and `touchedSpecs` lists both. Have the Developer agent modify a source file; confirm it operates on the Supervisor worktree for the same branch and `touchedSourcePaths` is appended. Confirm that when the Supervisor preview spins up for the already-active spec-only feature, SpecFS's self-provisioned worktree is pruned first (N1 hand-off).

**Acceptance Scenarios**:
1. **Given** an active context, **When** two spec folders are written, **Then** both commits are on the same branch.
2. **Given** the same context, **When** the Developer agent modifies BOS source, **Then** the work happens on the Supervisor's worktree for `bos/feat/<id>`, not the running source tree.
3. **Given** a spec-only feature with a self-provisioned worktree, **When** it becomes source-inclusive, **Then** SpecFS flushes and prunes its worktree before the Supervisor adds its own — no `already checked out` failure, no lost commits.
4. **Given** the context file, **When** the server restarts mid-feature, **Then** writes resume on the same branch (context persisted; uncommitted worktree state swept into a recovery commit).

### User Story 3 — Spec-only promotion is instant; conflicts are first-class (Priority: P1)

A user edits only specs and promotes. It completes in seconds with no rebuild. If `main` advanced and the merge conflicts, the user gets a clear conflict result, not a silent overwrite.

**Independent Test**: Create context, write specs, promote. Confirm merge to `main` in `data/specs/user/` and no rebuild. Separately, advance `main` to force a conflict; confirm promote returns `{ kind: 'conflict', files }` and `main` is untouched.

**Acceptance Scenarios**:
1. **Given** `touchedSourcePaths` empty, **When** promote runs, **Then** pending writes are flushed, the branch is reconciled and fast-forwarded to `main`, no rebuild.
2. **Given** `touchedSourcePaths` non-empty, **When** promote runs, **Then** the spec branch merges and the source branch is surfaced for PR review.
3. **Given** `main` advanced with an overlapping change, **When** promote runs, **Then** it returns a conflict result listing the files and leaves `main` unchanged.

### User Story 4 — VFS wipe does not destroy specs (Priority: P1)

Clearing the VFS leaves specs intact.

**Independent Test**: Write a spec, wipe `data/vfs/`, confirm `data/specs/user/` and its history remain and reappear under `Documents/Specs/`.

**Acceptance Scenarios**:
1. **Given** specs written, **When** `data/vfs/` is cleared, **Then** `data/specs/user/` is unaffected.
2. **Given** a fresh VFS, **When** `vfs.list('Documents/Specs/')` runs, **Then** specs are visible again (mount re-established at startup, after the repo is ensured).

### User Story 5 — System-spec edits flow through the Developer agent (Priority: P2)

A maintainer changes a system spec (e.g. merging a feature into `overview.md`). Because system specs are source, the change is made on the feature branch via the Developer agent and promoted with code.

**Independent Test**: Attempt `vfs.writeText('Documents/Specs/…')` targeting a system store → refused (read-only). Delegate the same edit to the Developer agent on the active feature branch; confirm it lands in `seed/spec-store/` on `bos/feat/<id>`.

**Acceptance Scenarios**:
1. **Given** a system store, **When** a VFS write targets it, **Then** it is refused as read-only.
2. **Given** an active feature context, **When** a system-spec edit is delegated, **Then** it is applied as a source change on the correlated branch.
3. **Given** a new BOS release that changed a system spec, **When** an existing user boots, **Then** `data/specs/system/` is mirrored to match (N2), so the change reaches them.
