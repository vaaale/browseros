# Feature Specification: Data Isolation (DataFS)

**Feature Branch**: `006-data-isolation`

**Created**: 2026-06-28 (migrated from `spec/self-modification/datafs.md`)

**Status**: Implemented

**Input**: "A single layer for all BOS runtime state that lets concurrent versions share one canonical store while a previewed candidate writes to an isolated, throwaway clone — working on any filesystem via capability probing and graceful degradation."

> Migrated from `spec/self-modification/datafs.md`. Data-plane counterpart to `005-self-modification`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Previewing a candidate never pollutes my real data (Priority: P1)

While a candidate is previewed, base data is read-only; the candidate writes to an isolated clone that is discarded afterward.

**Acceptance Scenarios**:

1. **Given** a previewed candidate, **When** it writes data, **Then** the writes land in its clone and base is unchanged.
2. **Given** the preview ends (discard or promote), **When** the clone is dropped, **Then** base is exactly as before.

### User Story 2 - It works on any filesystem (Priority: P1)

A probe selects the best compatible isolation method; a universal copy/overlay floor always works (SMB/FAT/FUSE included).

### User Story 3 - I choose the isolation method (Priority: P2)

The first-run wizard and Settings let the user pick the method; only probe-compatible methods are selectable.

### Edge Cases

- Where atomic rename-over-existing is not guaranteed, writes still replace the file; only crash-atomicity degrades to best-effort.
- Orphaned clones left by a crash MUST be reclaimable (GC).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All runtime-state access MUST funnel through one server-only DataFS module rooted at a configurable dir (`BOS_DATA_DIR`, default `<cwd>/data`); no store may join `process.cwd()/data` directly.
- **FR-002**: While a candidate is previewed, base data MUST be **read-only** (the core invariant); the preview's writes go to a separate clone. The invariant requires only read+write, so it holds on SMB/FAT/FUSE.
- **FR-003**: Every write MUST funnel through `writeAtomic()` (temp file in the same dir → flush → rename over target); where atomic rename is unavailable it degrades to best-effort.
- **FR-004**: BOS MUST implement clone backends ordered best→floor: ZFS/btrfs snapshot, reflink copy, hardlink farm, plain deep copy (the universal floor), and sparse overlay (app-level CoW). Each MUST preserve base-read-only; deep copy and overlay are ALWAYS compatible.
- **FR-005**: A startup/on-demand capability probe MUST detect reflink/hardlink/atomic-rename/CoW+privilege support and yield the compatible method set; the active method is chosen from it (default best available; the user setting overrides within the compatible set).
- **FR-006**: A `datafs` config namespace MUST expose the isolation method (only compatible methods selectable; incompatible shown disabled with a reason), a capability read-out, and a re-probe action; the first-run wizard MUST let the user choose (defaulting to the best compatible option).
- **FR-007**: Promote is **code-only** — DataFS supports discarding a clone, never merging it back (promote-and-merge is out of scope); `active` with no preview in progress uses base directly with zero clone overhead.
- **FR-008**: On-disk `data/` schema changes MUST be backward-compatible; clones/overlays are local artifacts and MUST NOT be shipped; orphaned clones MUST be garbage-collectable.

### Key Entities

- **DataFS module** — the single server-only access funnel.
- **Base data root** — the canonical store (`active`).
- **Clone** — an isolated writable copy for a preview (per backend).
- **Capability probe** — detects compatible isolation methods.
- **`datafs` config namespace** — method selection + capability read-out.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Preview writes never touch base data.
- **SC-002**: Isolation works on a copy-only filesystem (no CoW/hardlinks required).
- **SC-003**: Only probe-compatible isolation methods are selectable in Settings.
- **SC-004**: `active` runs with zero clone/overlay overhead when nothing is being previewed.

## Notes

- Drives the preview/promote/discard lifecycle of `005-self-modification`; the `002-memory` store is one consumer. Installed apps are NOT a DataFS store — they are versioned content in `007-gitfs`.
- Faithful migration of `spec/self-modification/datafs.md`; original prose remains in git history.
