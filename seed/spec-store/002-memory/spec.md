# Feature Specification: Memory System

**Feature Branch**: `002-memory`

**Created**: 2026-06-28 (migrated from `spec/memory/memory.md`)

**Status**: Implemented

**Input**: "A self-improving memory system modeled on Hermes-Agent, so the assistant stops the user repeating themselves and gets better at recurring tasks over time — without unbounded context growth and without hardening transient failures into permanent constraints."

> Migrated from the legacy prose spec `spec/memory/memory.md`. It documents an as-built feature, so requirements are stated as the behavior the system must uphold. The original rationale prose is preserved in git history. Companion: `003-self-improvement` defines the learning loop that writes to memory.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The assistant remembers who I am (Priority: P1)

The user states a preference, correction, or personal detail once; in later sessions the assistant behaves accordingly without being told again.

**Acceptance Scenarios**:

1. **Given** the user states a durable preference, **When** a later session starts, **Then** it is present in the assistant's injected context and shapes its behavior.
2. **Given** the user corrects the assistant, **When** the same situation recurs later, **Then** the assistant follows the correction.

### User Story 2 - Memory stays bounded and high-signal (Priority: P1)

Memory never grows without limit; when full, the system consolidates rather than dropping or truncating.

**Acceptance Scenarios**:

1. **Given** agent memory is at its size budget, **When** a new entry is written, **Then** the write is rejected with the current entries plus a consolidation instruction, and a batch operation can free space and add the entry atomically.

### User Story 3 - I can review and correct what is remembered (Priority: P2)

The Memory app lets the user view, edit, and remove entries in the user profile and agent memory.

**Acceptance Scenarios**:

1. **Given** stored memory, **When** the user opens the Memory app, **Then** they can view, edit, and remove entries in both surfaces.

### Edge Cases

- A poisoned/injection-bearing entry MUST be neutralized in the injected snapshot (replaced by a marked placeholder) while remaining visible in the raw store for review.
- Out-of-band edits to the on-disk store MUST be detected (drift) and reconciled, not silently overwritten.
- Leaf sub-agents MUST NOT write to shared memory.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Long-term knowledge MUST be split into three surfaces — **user profile** (who the user is), **agent memory** (the assistant's notes), and **skills** (procedural knowledge) — and reusable procedures MUST live in skills, never as memory entries.
- **FR-002**: Ephemeral content (task progress, completed-work logs, TODO state, raw dumps, one-off narratives) MUST NOT be written to durable memory.
- **FR-003**: User profile and agent memory MUST be bounded and curated (configurable per-surface character budgets), de-duplicated, and stored as markdown under `data/memory/` with crash-safe atomic writes and read-modify-write locking.
- **FR-004**: On budget overflow the system MUST reject the write and return the current entries plus a consolidation instruction; a batch shape (atomic, all-or-nothing) MUST allow consolidate-and-add in a single call.
- **FR-005**: The curated core MUST be injected into the composed system instructions as a per-session **frozen snapshot** (preserving the prefix cache), refreshed at the next session start, and MUST survive context compression.
- **FR-006**: Writes MUST go through a single `memory` tool with `target` ∈ {user, memory} and `action` ∈ {add, replace, remove}; replace/remove identify entries by a unique substring; success responses MUST be terminal (no full-list echo on success).
- **FR-007**: A post-task self-improvement review (a restricted pass) MUST write durable facts to memory and MUST NOT record transient or environment-specific failures or one-off narratives.
- **FR-008**: Memory content MUST be scanned for prompt-injection/exfiltration at write time and at snapshot-build time; poisoned entries are placeholdered in the snapshot but kept in the raw store.
- **FR-009**: External drift on the on-disk store MUST be detected and reconciled (back up and refuse) rather than silently overwritten.
- **FR-010**: Leaf sub-agents MUST NOT write to shared memory; the delegating parent decides what to remember.
- **FR-011**: An optional queryable/semantic recall tier MAY exist (a recall tool), complementary to the always-injected core; BOS MAY support one external memory provider at a time, selected in configuration.
- **FR-012**: The Memory app MUST let the user view/edit/remove entries in both surfaces; configuration MUST expose memory budgets, the review toggle/model, the write-approval gate, the active provider, and Curator settings (and thereby expose them to the assistant as tools).

### Key Entities

- **User profile** — identity, role, durable preferences, communication style.
- **Agent memory** — environment facts, conventions, tool quirks, lessons, current operational state.
- **Skill** — procedural knowledge (a directory: `SKILL.md` + optional `references/`, `scripts/`, `templates/`); carries provenance.
- **Memory tool** — the single write path (target/action, substring addressing, atomic batch).
- **Memory provider** — pluggable backend (built-in file-backed default; optional external).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A stated user preference does not need to be repeated across sessions.
- **SC-002**: Memory size stays within the configured budgets at all times (no unbounded growth).
- **SC-003**: Over-budget writes never silently drop or truncate; consolidation is always offered.
- **SC-004**: The injected system prompt is stable within a session (the prefix cache is preserved).
- **SC-005**: Poisoned memory entries cannot influence the model yet remain user-reviewable.

## Notes

- Companion specs: `003-self-improvement` (the learning loop and skill lifecycle). Skills are also governed by the constitution.
- Faithful migration of `spec/memory/memory.md`; the original prose (with rationale) remains in git history.
