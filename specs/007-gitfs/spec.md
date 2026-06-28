# Feature Specification: GitFS (Versioned Content Layer)

**Feature Branch**: `007-gitfs`

**Created**: 2026-06-28 (migrated from `spec/self-modification/gitfs.md`)

**Status**: Implemented

**Input**: "Storage for versioned, user-authored, shareable content (installed apps now, workflows later) in its own independent git repo — real history/merge, marketplace-ready — distinct from BOS source code and from DataFS runtime state."

> Migrated from `spec/self-modification/gitfs.md`. Third storage layer alongside BOS-code worktrees (`005-self-modification`) and runtime state (`006-data-isolation`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - My apps are versioned and never collide with BOS upstream (Priority: P1)

Content lives in its own git repo (not a subdirectory of the BOS repo, not a submodule), gitignored when nested, so a `git pull` on BOS source can never conflict with user content.

**Acceptance Scenarios**:

1. **Given** installed apps in the content repo, **When** the BOS source repo is updated, **Then** there is no conflict with user content.

### User Story 2 - App lifecycle is git-committed and registry-free (Priority: P1)

Installing/uninstalling/restoring/purging an app is a git commit; apps are discovered by listing the directory — there is no central registry file.

**Acceptance Scenarios**:

1. **Given** an app folder under the content root, **When** the desktop loads, **Then** the app is discovered by directory listing (no registry).
2. **Given** an app lifecycle action, **When** it completes, **Then** it is recorded as a git commit.

### User Story 3 - Preview an app candidate, then promote or discard (Priority: P2)

App candidates are git branches (branch-live preview), orthogonal to BOS-code candidates.

### Edge Cases

- The content root MUST be detected via `<root>/.git` (never `git rev-parse`) so it can never accidentally operate on an enclosing repo.
- Outside the Supervisor, `draft` is a no-op and apps install live (history/revert via uninstall/purge).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Versioned content MUST live in its OWN git repo, independent of the BOS source repo — NOT a tracked subdirectory and NOT a git submodule (a submodule would push gitlink churn/conflicts into the BOS repo); root from `BOS_APPS_DIR` (default `<cwd>/apps`), gitignored when nested in the BOS tree.
- **FR-002**: The DataFS↔GitFS line is decided by "does this need proper versioning?" — yes (user-authored, revertible, shareable: apps/workflows) → GitFS; no (latest-value-only runtime state) → DataFS. Shareability (marketplace) is the strongest GitFS signal.
- **FR-003**: A server-only GitFS module MUST expose `ensureRepo` (init via the `<root>/.git` check + seed an initial commit), `commitAll` (no-op when clean, with a local committer identity), and `history`; filesystem mutations are followed by `commitAll`.
- **FR-004**: Content MUST be discovered by listing the directory — each item a self-contained, self-describing folder; there MUST be NO central registry file (the merge hazard GitFS exists to avoid).
- **FR-005**: Apps MUST be GitFS content: `<appsDir>/<id>/` with the app's files plus an `app.json` manifest (`name, icon, createdAt, status, uninstalledAt?`), served at `/apps/<id>/` with a path-escape jail and an injected `<base href="/apps/<id>/">`; lifecycle `installApp` / `uninstallApp` (soft, keeps files) / `restoreApp` / `purgeApp`, each committed.
- **FR-006**: App candidates MUST be git branches (`app-candidate`) in the content repo — branch-live preview with no extra port — orthogonal to BOS-code candidates; begin/promote(merge)/discard via Supervisor endpoints.
- **FR-007**: The Developer building app content MUST be delegated with `contentOnly: true` so it does NOT provision a BOS-code candidate worktree; the result is installed via `installApp` onto the candidate branch.

### Key Entities

- **GitFS module** — server-only git operations over a content root.
- **Content repo** — the independent apps git repo (`BOS_APPS_DIR`).
- **App folder + `app.json`** — a self-contained, self-describing content item.
- **`app-candidate` branch** — branch-live preview unit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A `git pull` on BOS source never conflicts with user app content.
- **SC-002**: Apps are discovered with no central registry file.
- **SC-003**: Every app lifecycle action is a git commit in the content repo.
- **SC-004**: An app candidate previews branch-live and promotes via merge.

## Notes

- Content candidates reuse the same Supervisor machinery as `005-self-modification`, parameterized by repo. GitFS holds what `006-data-isolation` does not version. Future: workflows, marketplace (clone/pull/push), an FS registry, and a later SecFS for secrets.
- Faithful migration of `spec/self-modification/gitfs.md`; original prose remains in git history.
