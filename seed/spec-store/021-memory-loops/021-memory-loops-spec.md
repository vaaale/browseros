# Feature Specification: Memory Loops (Episodic Fast Loop & Consolidating Slow Loop)

**Feature Branch**: `021-memory-loops`

**Created**: 2026-07-05

**Status**: Ready for Implementation (spec, plan, and tasks complete; aligned with Scheduler unified engine)

**Input**: "Reflection must be hard-wired, not voluntary. A fast loop automatically extracts short-term memories (episodes) from conversations as they go idle. A slow loop runs hourly, distilling episodes into long-term memory and maintaining the skill library — patching skills that were used, and creating new skills only when a task is complex enough and generalizable enough (evidenced by recurrence). All memory is plain markdown; no vector search."

> Extends `002-memory` (storage substrate) and `003-self-improvement` (learning passes). This spec **replaces** the voluntary `skill_reflect` trigger model of 003 with two hard-wired scheduler jobs, and inserts an **episodic store** between reflection and long-term memory. Design follows the Letta sleep-time pattern (async consolidation) and ACE incremental curation (delta updates, never full rewrites).

---

## Problem

Today the review pass (`runReview`, 003 §Pass 1) only runs when the agent voluntarily calls `skill_reflect` — in practice, almost never. When it does run, it writes directly into long-term memory and skills from single-conversation evidence, which over-triggers skill creation (one-off procedures become permanent skills) and under-uses cross-conversation signals (recurrence). Long-term memory (`USER.md` 1200 / `MEMORY.md` 2000 chars) has no room for accumulated experience and no retrieval path.

## Architecture Overview

Both loops are registered as `category: 'system'` JobDefinitions in the **Unified Job Engine** (see `bos-system-specs/scheduler/spec.md`). Their persistence lives — like every other scheduled job — in the single unified store `/Documents/System/scheduler-jobs.json`; there is no separate scheduler configuration for the memory subsystem. The engine dispatches these system jobs to internal handlers (`memory.fast-loop`, `memory.slow-loop`) registered by this feature. Memory artifacts (episodes, watermarks, topics, archive) live under `/Documents/Memory/` in the VFS — user-accessible but read-only by convention (the automated loops are the only writers except for user-invoked memory tools).

```
live conversation ──(persisted to /Documents/Chats/<id>.json, client-side)
        │
        ▼
FAST LOOP — SYSTEM job in /Documents/System/scheduler-jobs.json, every ~2 min
  handler: internal → memory.fast-loop
  scan chats changed since watermark AND idle ≥ 5 min
  → LLM review of NEW turns only
  → write/update EPISODE (/Documents/Memory/Episodes/) + optional skill_patch
        │
        ▼
SLOW LOOP — SYSTEM job in /Documents/System/scheduler-jobs.json, hourly, overlap-locked
  handler: internal → memory.slow-loop
  → merge episodes into topic-sharded LTM (incremental ops only)
  → patch skills that were used; create skills only past the creation gate
  → mark episodes consolidated; archive old ones
        │
        ▼
LONG-TERM MEMORY                                    SKILLS (existing library)
  USER.md   (injected, 1200)                          data/skills/<id>/SKILL.md
  MEMORY.md (injected index, 2000)
  /Documents/Memory/Topics/<slug>.md (retrieved on demand via memory_search)
```

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reflection happens without anyone asking (Priority: P1)

The user finishes a conversation and walks away. Within minutes, an episode capturing the session's lessons exists on disk; within the hour, durable lessons are merged into long-term memory and skills — with zero agent volition and zero user action.

**Acceptance Scenarios**:

1. **Given** a conversation with ≥ 4 turns that stops receiving messages, **When** it has been idle for the configured threshold (default 5 min), **Then** the next fast-loop tick produces (or updates) exactly one episode file for it.
2. **Given** an episode with `status: pending`, **When** the next slow-loop run executes, **Then** the episode's durable content is merged into long-term memory / skills and the episode is marked `consolidated`.
3. **Given** a conversation that has NOT changed since its last review (watermark unchanged), **When** the fast loop ticks, **Then** no LLM call is made for it.
4. **Given** the user resumes an already-reviewed conversation, **When** it goes idle again, **Then** only the turns after the watermark are reviewed, and the existing episode is updated in place (never duplicated).

### User Story 2 - Long conversations are still reviewed in bounded chunks (Priority: P2)

**Acceptance Scenarios**:

1. **Given** an active conversation exceeding the unreviewed-turn cap (default 40), **When** the fast loop ticks, **Then** the completed portion is reviewed immediately (idle threshold waived) and the watermark advances.

### User Story 3 - Skills evolve conservatively from recurring experience (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a conversation in which an existing skill was used and corrected, **When** the slow loop consolidates its episode, **Then** that skill is patched (never a new skill created for it).
2. **Given** a novel, complex task solved once, **When** the slow loop runs, **Then** NO skill is created, but the episode records a `skill-candidate` tag describing the task class.
3. **Given** a second episode matching an existing `skill-candidate` task class, **When** the slow loop runs, **Then** a class-level skill is created (subject to the full creation gate, FR-014).
4. **Given** a smooth session with nothing durable, **When** either loop runs, **Then** "nothing to save" is valid: the fast loop may write a minimal episode or none; the slow loop makes no memory/skill changes.

### User Story 4 - Long-term memory grows beyond the injected budget and stays retrievable (Priority: P1)

**Acceptance Scenarios**:

1. **Given** consolidated knowledge exceeding `MEMORY.md`'s budget, **When** the slow loop merges it, **Then** detail lands in a topic file (`/Documents/Memory/Topics/<slug>.md`) and `MEMORY.md` carries a one-line index entry for the topic.
2. **Given** the agent needs details mid-conversation, **When** it calls `memory_search`, **Then** matching entries from topics and episodes are returned with their file/entry provenance.
3. **Given** any number of consolidation runs over the same topic file, **Then** its content is only ever modified by add/replace/remove-entry operations — a full-file rewrite never occurs (ACE anti-collapse rule).

### Edge Cases

- **Injection safety**: episode and topic content re-enters prompts (via consolidation input and `memory_search` results). Every write to episodes and topics MUST pass the existing `looksLikeInjection` scan; refused content is dropped with a note in the job log.
- **User-profile protection (carried from 003)**: automated runs never write `USER.md`. Both loops are automated; therefore neither writes `USER.md`. Identity facts discovered by the loops are recorded in the episode / `MEMORY.md` as *profile suggestions*; `USER.md` changes remain exclusive to the live agent's `memory_save` (user-visible) or the Memory app.
- **Transient-failure anti-patterns (003 FR-004) still bind both loops**: environment failures, negative tool claims, resolved errors, one-off narratives are never hardened. Fix-only capture.
- **Crash / overlap**: a slow-loop run that dies MUST NOT leave episodes half-marked — mark each episode `consolidated` only after its ops are applied. The overlap lock MUST expire (e.g. stale after 30 min) so a crashed run can't wedge the loop forever.
- **Clock/ordering**: episodes are consolidated oldest-first; consolidation of one episode must not depend on later ones.
- **Empty/no-provider**: both loops no-op cleanly when `hasCredentials()` is false (same as today's review).

---

## Requirements *(mandatory)*

### Functional Requirements — Episodic store

- **FR-001**: An episode is a markdown file `/Documents/Memory/Episodes/<yyyy-mm-dd>-<conversationId>.md` (VFS path) with frontmatter: `conversationId`, `createdAt`, `updatedAt`, `watermark` (last reviewed message id/index), `skillsUsed` (ids), `status: pending | consolidated`, optional `skillCandidates` (short task-class slugs). Body sections: **Task & outcome**, **What worked / what failed**, **Corrections received**, **Durable lesson candidates**, **Profile suggestions**.
- **FR-002**: Episode writes MUST be atomic (temp-file + rename, as in `memory/curated.ts`), idempotent per conversation (one file per convId per day; re-review updates it), and injection-scanned.
- **FR-003**: Consolidated episodes older than a threshold (default 14 days) are moved to `/Documents/Memory/Episodes/.Archive/` — never deleted (mirrors Curator policy).

### Functional Requirements — Fast loop

- **FR-004**: The fast loop MUST run as a **`category: 'system'` JobDefinition** in the **Unified Scheduler Engine** (see `bos-system-specs/scheduler/spec.md`), persisted like every other job in the single unified store `/Documents/System/scheduler-jobs.json`. Default interval every 2 min; handler `{ kind: 'internal', ref: 'memory.fast-loop' }`; no client-side hook and no agent volition. On startup the memory subsystem MUST seed this JobDefinition into the unified store by calling the scheduler engine's `ensureSystemJob(...)` API (idempotent by stable id `system:memory.fast-loop`); it MUST NOT maintain a separate persistence file for scheduling and MUST NOT create a job file under `src/lib/integrations/scheduler/`.
- **FR-005**: Eligibility per tick: conversation file in `/Documents/Chats` has messages beyond its watermark AND (idle ≥ idle-threshold OR unreviewed turns ≥ cap OR total turns beyond watermark ≥ 4 with conversation deleted/closed). Conversations with fewer than 4 new turns are skipped (debounce for trivial exchanges, per 003 FR-001).
- **FR-006**: The watermark MUST be persisted outside the conversation JSON the client owns (sidecar `/Documents/Memory/.watermarks.json`) to avoid write races with the client store.
- **FR-007**: The fast-loop LLM pass sees only the transcript slice after the watermark (plus the existing episode body for update context) and has a restricted toolset: `episode_write` (create/update sections), `skill_patch` (only for a skill explicitly corrected in-session), and nothing else. It MUST NOT create skills and MUST NOT write `USER.md`/`MEMORY.md`/topics. Its system prompt is the bundled [`prompts/fast-loop-system.md`](prompts/fast-loop-system.md) — normative, embedded verbatim (FR-021).
- **FR-008**: `skillsUsed` MUST be captured mechanically (from the usage telemetry / transcript tool calls), not left to the LLM's judgment.
- **FR-009**: The existing `skill_reflect` action becomes a manual "run the fast loop now for this conversation" trigger (kept for debugging/UX), delegating to the same code path.

### Functional Requirements — Slow loop

- **FR-010**: The slow loop MUST run as a **`category: 'system'` JobDefinition** in the **Unified Scheduler Engine**, persisted in the single unified store `/Documents/System/scheduler-jobs.json` (stable id `system:memory.slow-loop`, handler `{ kind: 'internal', ref: 'memory.slow-loop' }`), default hourly, and MUST exit immediately (no LLM call) when no `pending` episodes exist. Like the fast loop, the memory subsystem MUST seed this JobDefinition on startup by calling the scheduler engine's `ensureSystemJob(...)` API — it does NOT keep its own scheduler persistence and MUST NOT create a job file under `src/lib/integrations/scheduler/`.
- **FR-011**: Runs MUST be serialized by an overlap lock with staleness expiry; episodes are processed oldest-first in a bounded batch (default ≤ 10 per run).
- **FR-012**: Long-term memory MUST become topic-sharded: `/Documents/Memory/Topics/<slug>.md` (entry-list format identical to `MEMORY.md`; per-file budget default 4000 chars, enforced by rejection like today). `MEMORY.md` remains the always-injected index: one line per topic (`- <slug>: <one-line digest>`) plus genuinely global entries, within its existing 2000-char budget. `USER.md` semantics are unchanged.
- **FR-013**: The consolidation pass exposes ONLY incremental operations: `memory_add_entry(topic|memory, content)`, `memory_replace_entry`, `memory_remove_entry`, `topic_create(slug, digest)`, plus the existing skill tools, `episode_tag_candidate`, and `episode_mark_consolidated`. There is no "write file" tool. (ACE: monolithic rewrites cause context collapse.) Its system prompt is the bundled [`prompts/slow-loop-system.md`](prompts/slow-loop-system.md) — normative, embedded verbatim (FR-021).
- **FR-014**: **Skill creation gate** — the slow loop may create a skill only when ALL hold: (a) no existing skill covers the task class (it MUST `skill_list` first and prefer `skill_patch`, per 003 FR-005); (b) the task is complex enough that an unaided agent would plausibly fail or waste significant effort (multi-step, non-obvious ordering, discovered pitfalls); (c) generalizability is evidenced by the same task class appearing in ≥ 2 episodes (current batch or history — checked via search over episode files, not batch co-occurrence alone). A first occurrence records a `skillCandidates` tag on the episode instead.
- **FR-015**: For every episode whose `skillsUsed` is non-empty, the slow loop MUST load each used skill and decide patch / no-change, recording usage via the existing telemetry.
- **FR-016**: Merging MUST deduplicate and supersede: when a new lesson contradicts an existing entry, the old entry is replaced (timestamped supersession in the entry text), not appended alongside.

### Functional Requirements — Retrieval

- **FR-017**: A `memory_search(query)` tool (contexts: main chat + sub-agents + slow loop) MUST search `/Documents/Memory/Topics/**` and `/Documents/Memory/Episodes/**` and return matching entries with provenance. Initial implementation: case-insensitive substring/word match ranked by match count — **no new dependencies**. The module MUST isolate ranking so BM25 can replace it later without interface change. No vector search.
- **FR-018**: `memory_recall` (existing) is extended to include topic-index awareness: recalling a topic slug returns the topic file's entries.

### Functional Requirements — Configuration & observability

- **FR-019**: A `memoryLoops` config namespace (registered in `src/lib/config/registry.ts`, hence agent-visible) MUST expose: fast loop on/off, tick interval, idle threshold, turn cap; slow loop on/off, interval, batch size; model override per loop; episode archive age.
- **FR-020**: Both loops MUST log runs (start, conversations/episodes processed, ops applied, refusals) to the central logging facility, and the Memory app MUST show pending-episode count and last run summaries.

### Functional Requirements — Bundled artifacts

- **FR-021**: The system prompts of both LLM passes are **normative** and bundled with this spec: [`prompts/fast-loop-system.md`](prompts/fast-loop-system.md) (fast loop) and [`prompts/slow-loop-system.md`](prompts/slow-loop-system.md) (slow loop). The implementation MUST embed each prompt's body verbatim (leading HTML comment stripped); any wording change is a spec change and MUST be made in these files first.
- **FR-022**: The bundled runtime skill [`skills/recall-long-term-memory/SKILL.md`](skills/recall-long-term-memory/SKILL.md) MUST be added to the seeded-skill list (`SEED` in `src/lib/agent/skills/store.ts`, `created_by: seed`) so both fresh and existing installs receive it — it teaches the live assistant to retrieve topics/episodes via `memory_search`/`memory_recall` (FR-017/018).
- **FR-023**: The bundled development-time skill [`skills/implement-memory-loops/SKILL.md`](skills/implement-memory-loops/SKILL.md) (+ [`references/code-touchpoints.md`](skills/implement-memory-loops/references/code-touchpoints.md)) is the build procedure for the developer sub-agent. It is NOT seeded at runtime; install it into `data/skills/` (or hand it to the developer delegation) for the duration of the implementation. Where it conflicts with this spec, the spec wins.

### Key Entities

- **Episode** — short-term memory unit; one markdown file per conversation per day; the only artifact the fast loop produces.
- **Watermark** — per-conversation pointer to the last reviewed message; makes reviews incremental and idempotent.
- **Topic file** — budgeted, entry-listed long-term memory shard, indexed by one line in `MEMORY.md`, retrieved on demand.
- **Skill candidate tag** — recurrence evidence carried on episodes; two matching tags satisfy gate (c) of FR-014.
- **Consolidation run** — locked, batched, oldest-first slow-loop execution.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of conversations with ≥ 4 assistant turns have an episode within (idle-threshold + 2 × fast-tick) of going idle, with no user or agent action.
- **SC-002**: A conversation unchanged since its last review triggers zero LLM calls on subsequent fast-loop ticks; re-reviewing an extended conversation never produces a second episode file for the same day.
- **SC-003**: Pending episodes are consolidated within one slow-loop interval + run duration; an idle system (no pending episodes) incurs zero LLM cost from the slow loop.
- **SC-004**: No skill is created from single-occurrence evidence (verifiable from episode `skillCandidates` history); skills used in a conversation are always re-examined at consolidation.
- **SC-005**: Topic files never shrink by more than one entry per operation (no rewrites); `MEMORY.md` and `USER.md` stay within budget; automated runs produce zero writes to `USER.md`.
- **SC-006**: All 003 anti-pattern rules (FR-004) and archive-never-delete guarantees hold across both loops.

---

## Implementation Guidance *(informative — existing touchpoints)*

| Piece | Where | Notes |
|---|---|---|
| **Unified Scheduler Engine** | new `src/lib/scheduler/engine.ts` (Phase 0, prerequisite) | Single daemon reading/writing `/Documents/System/scheduler-jobs.json`. Handles all categories (system/user/integration). See `bos-system-specs/scheduler/spec.md`. Memory loops depend on this being in place. |
| Integration-config migration | new `src/lib/scheduler/migrate.ts` — one-time boot step invoked by the engine (Phase 0) | Migrates legacy per-integration polling configs into the unified `/Documents/System/scheduler-jobs.json` store (see scheduler spec FR-016). Not memory-loops-specific but blocks memory-loops rollout. |
| Episode store | new `src/lib/agent/memory/episodes.ts` | writes/reads under `/Documents/Memory/Episodes/` via VFS; copy atomic-write + `looksLikeInjection` patterns from `memory/curated.ts` |
| Fast loop | new `src/lib/agent/memory/fast-loop.ts`; refactor of `src/lib/agent/review.ts` | keep `runToolLoop` usage and the anti-pattern prompt rules; drop `skill_create` from its toolset. Exposes an internal handler `memory.fast-loop` for the engine. |
| Chat scanning | reuse `src/lib/agent/conversations-server.ts` (`/Documents/Chats/<id>.json` via VFS) | idle = file mtime / last message timestamp |
| Slow loop | new `src/lib/agent/memory/consolidate.ts` | move `skill_create`/`skill_patch` tool defs from `review.ts` into a shared module. Exposes an internal handler `memory.slow-loop` for the engine. |
| Scheduler job seeding | boot-time call to `ensureSystemJob(...)` (exported from `src/lib/scheduler/engine.ts`) for two `category: 'system'` JobDefinitions in `/Documents/System/scheduler-jobs.json` | Stable ids `system:memory.fast-loop`, `system:memory.slow-loop`; idempotent; do NOT create a separate persistence file for these and do NOT add anything under `src/lib/integrations/scheduler/`. Handler kind `internal` with the refs above. Lock file for slow-loop overlap remains under `/Documents/Memory/.consolidate.lock`. |
| Topics + search | extend `src/lib/agent/memory/curated.ts`; new `memory/search.ts` | entry format and budget-rejection semantics identical to today; search targets under `/Documents/Memory/` |
| Config | `src/lib/config/registry.ts` namespace `memoryLoops` | exposes settings tab + agent tools for free |
| API | `POST /api/memory/consolidate` (manual slow run), extend `/api/assistant/reflect` (manual fast run) | mirror curator's on-demand pattern; both invoke the same internal handlers the engine calls |
| Docs/spec | update `docs/dev/memory/memory.md`, `docs/dev/self-improvement/self-improvement.md`; register this spec via Build Studio; note the 003 trigger-model change in `discrepancies.md` | per working rules |
| Prompts | `prompts/fast-loop-system.md`, `prompts/slow-loop-system.md` (bundled) | normative, FR-021 — embed verbatim as module constants |
| Skill seeding | `skills/recall-long-term-memory/` (bundled) → `SEED` list in `skills/store.ts` | FR-022 |
| Build procedure | `skills/implement-memory-loops/` (bundled, + `references/code-touchpoints.md`) | FR-023 — for the developer sub-agent, not seeded |

Constraints: no new npm dependencies; no `package.json`/lockfile changes; feature branch `bos/memory-loops`; `npx tsc --noEmit` + `npm run lint` clean; do not run `npm run build` while `next dev` is live.

Suggested implementation order (each step shippable): (0) **Unified Scheduler Engine + integration-config migration** (prerequisite; see `bos-system-specs/scheduler/spec.md` and this feature's `tasks.md` Phase 0); (1) episode store + fast-loop refactor with manual trigger; (2) fast-loop system-category JobDefinition seeded into the unified store + watermarks; (3) slow loop + topics + slow-loop JobDefinition seeded into the unified store; (4) `memory_search` + config namespace + docs.

## Bundled Artifacts

```
specs/020 - memory-loops/
├── 020-memory-loops-spec.md                        this spec
├── prompts/
│   ├── fast-loop-system.md                         normative system prompt, fast loop (FR-021)
│   └── slow-loop-system.md                         normative system prompt, slow loop (FR-021)
└── skills/                                         BOS skill format: <id>/SKILL.md (+ references/)
    ├── implement-memory-loops/
    │   ├── SKILL.md                                developer build procedure (FR-023)
    │   └── references/
    │       └── code-touchpoints.md                 per-file design detail
    └── recall-long-term-memory/
        └── SKILL.md                                runtime skill, seeded with the feature (FR-022)
```

## Notes

- Companions: `002-memory`, `003-self-improvement`, `scheduler` (Unified Job Engine). This spec supersedes 003's voluntary-trigger model for Pass 1; GEPA (Pass 2) and Curator (Pass 3) are unchanged and remain on-demand (the Curator MAY later be moved onto the same scheduler by registering an additional System-category JobDefinition in the unified store).
- **Persistence coupling**: This feature deliberately relies on the unified `/Documents/System/scheduler-jobs.json` for its scheduling. The memory subsystem MUST NOT maintain a parallel scheduler config, a "derived view", or a split persistence file — the whole point of Phase 0 is that there is exactly one store for every job.
- Deliberate non-goals (unchanged):
  - vector/embedding search;
  - a third memory store beyond memory+skills (episodes are a *buffer*, not a store the live agent writes);
  - client-side reflection hooks;
  - automatic `USER.md` writes;
  - **prompt-injection detection improvements beyond today's `looksLikeInjection` scan** — future enhancement, tracked separately; both loops rely on the existing scanner as-is.
