# Feature Specification: Self-Improvement (Learning Loop & Skill Lifecycle)

**Feature Branch**: `003-self-improvement`

**Created**: 2026-06-28 (migrated from `spec/self-improvement/self-improvement.md`)

**Status**: Implemented

**Input**: "The assistant gets better over time from its own experience and user feedback — turning conversations into durable improvements to its memory, its skills, and (where appropriate) BOS itself — while learning conservatively and never hardening transient failures into permanent constraints."

> Migrated from `spec/self-improvement/self-improvement.md`. Companion: `002-memory` (the substrate the loop writes to). Two scopes: **agent learning** edits `data/` (memory + skills); **BOS self-improvement** edits `src/` via the developer sub-agent.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The assistant learns without me repeating feedback (Priority: P1)

After a non-trivial task, a reflective review updates memory and skills so the next session starts already corrected.

**Acceptance Scenarios**:

1. **Given** the user corrects the assistant's approach, **When** the review runs after the task, **Then** the lesson is embedded in the skill governing that class of task.
2. **Given** a smooth session with no corrections, **When** the review runs, **Then** "nothing to save" is an acceptable outcome.

### User Story 2 - Skills improve and the library stays tidy (Priority: P1)

Skills are optimized from accumulated feedback (GEPA) and the Curator retires/consolidates stale agent-created skills — archiving, never deleting.

**Acceptance Scenarios**:

1. **Given** repeated feedback about a skill, **When** GEPA optimization runs, **Then** an improved, higher-scoring variant becomes active and the prior version is retained for rollback.
2. **Given** an agent-created skill idle past its threshold, **When** the Curator runs, **Then** it transitions active→stale→archived (restorable), never hard-deleting and never touching seeded/pinned skills.

### User Story 3 - Proactive suggestions are consent-first (Priority: P2)

Recurring patterns surface as suggestions the user accepts or dismisses; nothing runs automatically.

**Acceptance Scenarios**:

1. **Given** a recurring request, **When** the loop proposes an automation, **Then** it is offered as a suggestion and is never auto-created; a dismissed suggestion is not re-offered.

### Edge Cases

- A transient/environment failure (missing binary, unconfigured credential) MUST NOT become a durable rule — only the fix is captured.
- Background passes MUST NOT corrupt the live conversation, its prompt cache, or the user profile (automated/cron runs never write the user profile).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: After a completed non-trivial task, a reflective review MUST run as a separate (background/forked) pass — debounced for trivial exchanges and configurable (on/off and which model).
- **FR-002**: The review MUST run with a restricted toolset (memory + skill-management only), take no real-world actions, and MUST NOT mutate the live conversation or its prompt cache.
- **FR-003**: The review MUST write durable user facts to memory and patch/create skills from skill-worthy signals (style/tone/format/workflow corrections, frustration, "remember this", non-trivial techniques/fixes, and skills found wrong or outdated).
- **FR-004**: The loop MUST NOT capture anti-patterns — environment-dependent failures, negative tool claims, resolved transient errors, or one-off task narratives. Capture the fix, never "X doesn't work."
- **FR-005**: Skill mutation MUST support create / edit / patch / delete (agent-created, non-pinned only) / add-remove support files; the loop MUST prefer updating a loaded or umbrella skill over creating a new one; new skills MUST have class-level names (never a session artifact).
- **FR-006**: GEPA-style optimization MUST improve a skill's instructions by reflection (diagnose why it underperformed, then rewrite), evaluate and score candidate variants against representative tasks (Pareto/score-based selection), proceed in bounded rounds, and retain prior versions for rollback; triggers include user feedback, self-reflected weakness, and repeated failures.
- **FR-007**: A background Curator MUST manage agent-created skills via usage telemetry and deterministic staleness transitions (active→stale→archived), archive-but-never-delete (restorable; backup before any destructive pass), touch only agent-created skills, exempt pinned skills from auto-archive, and persist scheduler state; an LLM consolidation pass is opt-in.
- **FR-008**: The assistant MUST self-evaluate task performance honestly (corrections, retries, acceptance), feeding what the review captures and each skill's performance score.
- **FR-009**: Proactive suggestions MAY be offered (new skill / memory / automation) but MUST be consent-first; the system MUST NOT auto-create automations or take proactive actions; dismissed suggestions MUST NOT be re-offered.
- **FR-010**: BOS self-improvement (codebase) MUST go through the developer sub-agent on a git feature branch (typecheck, stage, docs updated), editing `src/` — distinct from agent learning, which edits `data/`. When asked to build, the assistant MUST first state whether architectural changes are warranted.
- **FR-011**: Configuration MUST expose review on/off + model, GEPA triggers, Curator settings (interval, staleness/archive thresholds, prune-bundled), and the proactive-suggestions toggle (as a namespace, and thereby to the assistant as tools); the assistant MUST surface what it learned (review summary in the UI and/or Memory app).

### Key Entities

- **Reflective review pass** — restricted, post-task memory/skill curation.
- **Skill** — procedural unit with provenance (agent vs seeded) and a performance score.
- **Curator** — lifecycle manager (telemetry sidecar, staleness state, archive/restore).
- **GEPA optimizer** — reflective skill-instruction improver producing scored variants.
- **Suggestion** — a consent-gated proactive proposal.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The same class-of-task feedback does not need to be given twice (the lesson lands in the skill).
- **SC-002**: No transient/environment failure becomes a durable rule.
- **SC-003**: The skill library does not grow unboundedly; nothing is ever hard-deleted (archive + restore).
- **SC-004**: Background passes never corrupt the live conversation, prompt cache, or user profile.
- **SC-005**: No proactive automation runs without explicit user consent.

## Notes

- Companion: `002-memory`. The feature-branch and delegation rules are also in the constitution.
- Faithful migration of `spec/self-improvement/self-improvement.md`; original prose remains in git history.
