# Feature Specification: Branch-Coupled Spec Provisioning

**Feature Branch**: `020-branch-coupled-specs`

**Created**: 2026-07-05

**Status**: Draft

**Input**: "Replace the symlink mount of external spec stores into dev-harness worktrees with per-store git worktrees on the SAME feature branch as the code, so one feature = one branch name spanning the BOS repo and every spec store. Fixes the Turbopack symlink failure and the hardlink new-file blindspot, makes preview spec content match the code that implements it, and promotes spec + code together."

> Supersedes `018-external-spec-store` **FR-005** (global `spec-candidate` branch) and **FR-007** (read-only symlink mount into the worktree). Store discovery, manifests, seeding, and multi-root spec-fs (018 FR-001..FR-004, FR-008..FR-010) are unchanged.

## Why this exists (context)

018 mounted the spec-store container into each preview worktree as a symlink at `specs/`. Turbopack traverses the project root and rejects symlinks that resolve outside it (the same failure documented for `node_modules`), so preview builds break. An earlier hardlink attempt failed differently: a file *created* in the worktree exists only there — hardlinks alias inodes, not directory entries — so new specs never reached the canonical store.

Separately, the workflow had a coherence gap: spec authoring delegated to the developer harness landed on whatever branch the harness happened to provision, while the user watched from base — in-progress specs were invisible, and spec content in a preview did not necessarily match the code being previewed.

The fix uses git's own mechanism. Spec stores are already independent git repos; a **git worktree of each store, checked out on the feature branch, placed inside the code worktree at `specs/<store>/`** gives the harness real directories (Turbopack-safe), propagates new files through commits (shared object DB + refs), and couples the spec version to the code version for preview and promote.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preview builds succeed with spec stores mounted (Priority: P1)

A provisioned preview worktree containing spec stores builds under Turbopack with no symlink in the project root.

**Independent Test**: Provision a preview for a feature branch with stores present; run the build; confirm success and that `specs/` inside the worktree is a real directory tree.

**Acceptance Scenarios**:

1. **Given** a preview worktree with mounted stores, **When** `npm run build` runs, **Then** it completes without symlink-resolution errors.
2. **Given** the BOS repo's gitignore, **When** the candidate `git add -A` runs, **Then** nothing under `specs/` is staged into the code branch.

### User Story 2 - One feature branch spans code and specs (Priority: P1)

Provisioning a preview for `bos/<feature>` checks out (creating if absent) the branch `bos/<feature>` in every spec store as a worktree at `specs/<store>/` inside the code worktree. Harness spec edits are committed on that store branch; new files included.

**Independent Test**: Delegate a change that creates a new spec file; confirm the file appears as a commit on the store's feature branch, visible from the canonical store repo via `git log`.

**Acceptance Scenarios**:

1. **Given** a provisioned preview, **When** the harness creates a new spec file and it is committed, **Then** the canonical store repo shows the commit on the feature branch.
2. **Given** a preview build request, **When** the Supervisor commits the code worktree, **Then** it also commits every mounted store worktree on the same branch name.
3. **Given** a restored preview after Supervisor restart, **When** it is re-provisioned from its git branch, **Then** the store worktrees are re-mounted on the same branch.

### User Story 3 - In-progress specs are visible from base (Priority: P1)

A user on base sees specs being drafted on feature branches: Build Studio lists each store's draft branches and the features changed on them, and renders their content read-only — no preview build, no version switch.

**Independent Test**: With a spec edit committed on `bos/<feature>` in a store, open Build Studio on base; confirm the draft feature appears (badged with its branch) and its content renders.

**Acceptance Scenarios**:

1. **Given** a store with commits on `bos/<feature>` that differ from its default branch, **When** Build Studio loads on base, **Then** the changed features appear under the store group, labelled with the branch.
2. **Given** a draft artifact opened from a branch, **When** the user views it, **Then** the branch content renders and editing is disabled.

### User Story 4 - Promote lands spec and code together; discard drops both (Priority: P2)

Promoting `bos/<feature>` merges the code branch into the BOS base branch AND merges each store's `bos/<feature>` branch into that store's default branch; discarding deletes both. Store merge conflicts are detected before the code promote's point of no return.

**Independent Test**: Promote a feature that changed code and a spec; confirm both merges landed. Discard another; confirm both branches are gone.

**Acceptance Scenarios**:

1. **Given** a ready preview with spec commits, **When** promote succeeds, **Then** the store default branch contains the spec change and the store feature branch is deleted.
2. **Given** a store feature branch that conflicts with the store default, **When** promote is requested, **Then** it fails BEFORE the base branch ref moves, with the conflict surfaced.
3. **Given** a discard, **When** it completes, **Then** the code branch, store branches, and all worktrees are removed; canonical stores are untouched.

### User Story 5 - Base-side spec edits commit directly (candidate branch retired) (Priority: P2)

The global `spec-candidate` branch is retired. Direct Build Studio edits on base commit-on-save to the store's default branch (all stores); review/staging happens on feature branches, which are the single candidate mechanism.

**Independent Test**: Edit a system spec from base Build Studio; confirm it commits to the store default branch with no candidate branch created.

**Acceptance Scenarios**:

1. **Given** a base-side system-spec edit, **When** it is saved, **Then** it is committed on the store's default branch and immediately visible.
2. **Given** the retired flow, **When** Build Studio renders, **Then** no per-store Promote/Discard candidate buttons appear; feature promotion happens via the version controls.

### Edge Cases

- The BOS repo MUST keep gitignoring `specs/` so store worktrees (including their `.git` pointer files) are never staged by the candidate `git add -A`.
- A store worktree cannot be added when its branch is checked out in another registered worktree; provisioning MUST `git worktree prune` the store first and reuse an intact existing mount.
- A leftover `specs` symlink from the previous design MUST be removed on provision (migration).
- Preview server processes MUST resolve the spec root to `<worktree>/specs` and MUST NOT run store seeding (seeding is base's job; a seed commit on a feature branch would pollute it). Base processes resolve the canonical root explicitly.
- After the promote swap adopts the candidate worktree as the new base, the store worktrees inside it are orphaned; they MUST be removed via `git worktree remove` in the store repo (never a bare branch delete, which fails while checked out).
- Supervisor cleanup paths (`fs.rm` of worktrees, boot reconcile) only ever delete worktree *copies*; committed spec work survives in the store repos. Uncommitted store-worktree edits are lost on discard by design (same as code).
- Stores discovered inside a preview are git-worktree checkouts whose `.git` is a file, not a directory; discovery MUST accept that.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Preview provisioning MUST mount every discovered spec store into the code worktree at `specs/<store>/` as a **git worktree of that store checked out on the code's feature branch** (created off the store's default branch when absent). No symlinks, no hardlinks, no copies. Mount MUST be refreshed on provision/restore and MUST replace a legacy symlink.
- **FR-002**: The Supervisor MUST commit mounted store worktrees (`git add -A` + commit) whenever it commits the code worktree for a build, so spec work is never lost to a discard-by-crash and is visible via the store's refs.
- **FR-003**: Promote MUST merge each store's feature branch into the store's default branch; store-merge conflicts MUST be pre-checked (via `git merge-tree`) and fail the promote BEFORE the base branch ref moves. Discard MUST delete the store feature branches and their worktree registrations. Both MUST leave canonical stores intact on failure paths.
- **FR-004**: Version server processes MUST receive an explicit spec root: previews `<worktree>/specs`, base the canonical `BOS_SPECS_ROOT` — never inherited ambiguity. Previews MUST skip store seeding.
- **FR-005**: The global `spec-candidate` branch and its promote/discard/status API actions MUST be removed. All stores commit-on-save on direct edits; feature branches are the only staging mechanism. (`requiresPromote` in store manifests is retained as metadata but no longer routes writes.)
- **FR-006**: Build Studio MUST surface **draft branches**: per store, list `bos/*` branches whose tree differs from the default branch, show the changed features under the store group labelled with their branch, and serve their file content read-only from git (no checkout). The spec read API MUST accept an optional `branch` parameter.
- **FR-007**: Spec authoring delegated to the developer harness MUST target a feature branch from the start (the harness provisions `bos/<feature>` before writing), so drafts are always on a branch that base can see via FR-006 and later implementation continues on the same branch.

### Key Entities

- **Store worktree mount** — a git worktree of a spec store, on the feature branch, at `specs/<store>/` inside the code worktree.
- **Draft branch** — a `bos/*` branch in a store repo whose tree differs from the store default; the unit of in-progress spec visibility and of spec promote.

## Success Criteria *(mandatory)*

- **SC-001**: `npm run build` succeeds in a provisioned preview worktree with stores mounted; no symlink exists under the worktree.
- **SC-002**: A new spec file created by the harness is visible from base (Build Studio draft view) after the next store commit, with zero builds.
- **SC-003**: Promote of a feature with spec + code changes results in both landing on their respective default/base branches under one action; discard removes both.
- **SC-004**: Killing the Supervisor mid-preview and restarting leaves canonical store repos intact and re-mounts store worktrees for restored previews.
- **SC-005**: No code path references the `spec-candidate` branch.

## Assumptions

- Linux-only deployment (native or Docker); single local user.
- Branch names are shared verbatim across the BOS repo and store repos; the `bos/<kebab>` validation already enforced by the Supervisor applies to store branches too.
- Store repos remain lightweight (markdown), so per-preview store worktrees are cheap.
- `docs/` lives in the BOS source tree and is therefore already branch-coupled; nothing to do.
