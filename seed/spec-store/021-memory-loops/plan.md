# Implementation Plan: Memory Loops (Episodic Fast Loop & Consolidating Slow Loop)

**Feature**: 021-memory-loops  
**Spec Status**: Draft → Ready for Planning  
**Target Branch**: `bos/memory-loops`

---

## Technical Context

This feature implements two automated scheduler jobs that replace the voluntary `skill_reflect` trigger model from spec 003:

1. **Fast Loop** (every ~2 min): Scans idle conversations, reviews new turns, writes/updates episode files
2. **Slow Loop** (hourly): Consolidates pending episodes into long-term memory topics and patches/creates skills

**Prerequisite — Unified Job Engine (Phase 0).** Both loops are registered as `category: 'system'` JobDefinitions in the Unified Job Engine (see `bos-system-specs/scheduler/spec.md`). All jobs (System / User / Integration) persist to a **single** file `/Documents/System/scheduler-jobs.json`. There is no separate scheduler persistence for the memory subsystem — the loops seed themselves via `ensureSystemJob(...)` at boot. Phase 0 also includes the one-time migration of any pre-existing integration polling configs into the unified store.

### Existing Touchpoints

| Component | Path | Role in This Feature |
|-----------|------|---------------------|
| **Unified Job Engine** (Phase 0) | `src/lib/scheduler/engine.ts` (new) | Daemon + persistence for ALL scheduled jobs; loads `/Documents/System/scheduler-jobs.json`. Prerequisite for this feature. |
| **Integration-config migration** (Phase 0) | `src/lib/scheduler/migrate.ts` (new) | One-time boot step; migrates legacy per-integration polling configs into the unified store (scheduler spec FR-016). |
| Memory store | `src/lib/agent/memory/curated.ts` | Atomic writes, injection scanning, budget enforcement |
| Review loop | `src/lib/agent/review.ts` | Refactored: fast-loop logic extracted, toolset restricted |
| Scheduler seeding | `src/lib/agent/memory/fast-loop.ts` + `consolidate.ts` | On boot, each calls `ensureSystemJob(...)` to place its JobDefinition in the unified store. Also registers internal handlers `memory.fast-loop` / `memory.slow-loop` with the engine. |
| Conversations | `src/lib/agent/conversations-server.ts` | VFS access to `/Documents/Chats/<id>.json` |
| Skills store | `src/lib/agent/skills/store.ts` | SEED list extended with `recall-long-term-memory` |
| Config registry | `src/lib/config/registry.ts` | New `memoryLoops` namespace |
| Logging | Central logging facility (spec 017) | Both loops log runs, ops, refusals |

### New Modules to Create

```
# Phase 0 — Unified Job Engine (prerequisite; owned by scheduler spec, listed here for context)
src/lib/scheduler/
├── engine.ts             # Unified Job Engine: loads /Documents/System/scheduler-jobs.json,
│                         # dispatches by handler.kind, tick loop, atomic writes, external re-read
├── migrate.ts            # One-time migration of legacy integration polling configs
└── acl.ts                # Category-based ACL helpers (getEditableFields, validation)

# Phase 1–4 — Memory Loops
src/lib/agent/memory/
├── episodes.ts           # Episode CRUD, atomic writes (writes under /Documents/Memory/Episodes/)
├── fast-loop.ts          # Fast loop logic + registers `memory.fast-loop` handler + seeds System JobDefinition
├── consolidate.ts        # Slow loop logic + registers `memory.slow-loop` handler + seeds System JobDefinition
├── watermarks.ts         # Sidecar at /Documents/Memory/.watermarks.json
├── topics.ts             # Topic file management (writes under /Documents/Memory/Topics/)
└── search.ts             # memory_search implementation (substring match + ranking)

# Note: NO src/lib/integrations/scheduler/jobs/memory-*.ts — the unified store is the ONLY
# persistence; loops seed via ensureSystemJob(...) rather than owning a separate job file.

prompts/
├── fast-loop-system.md   # Normative system prompt (FR-021)
└── slow-loop-system.md   # Normative system prompt (FR-021)

skills/
├── implement-memory-loops/
│   ├── SKILL.md          # Developer build procedure (FR-023)
│   └── references/
│       └── code-touchpoints.md  # Per-file design detail
└── recall-long-term-memory/
    └── SKILL.md          # Runtime skill, seeded (FR-022)

# VFS layout (user-accessible, written by the loops)
/Documents/System/
├── scheduler-jobs.json           # Single unified store: all JobDefinitions, all categories
└── scheduler-history/
    └── <jobId>.jsonl             # Per-job append-only run history

/Documents/Memory/
├── Episodes/                     # Episode files: <yyyy-mm-dd>-<conversationId>.md
│   └── .Archive/                 # Consolidated episodes >14 days old
├── Topics/                       # Topic shards: <slug>.md
├── .watermarks.json              # Per-conversation review pointers
└── .consolidate.lock             # Slow-loop overlap lock (30-min staleness expiry)
```

---

## Constitution Check

Against `.specify/memory/constitution.md` (principles from spec 001):

| Principle | Compliance |
|-----------|------------|
| **Specs before code** | ✅ This plan derives from the approved spec; implementation delegates to Developer |
| **No npm dependencies** | ✅ Search uses substring/ranking; no vector/embedding libs |
| **Atomic writes** | ✅ Episode/topic ops use temp-file + rename (pattern from `curated.ts`) |
| **Injection safety** | ✅ All writes scanned via existing `looksLikeInjection` |
| **Incremental ops only** | ✅ ACE anti-collapse: no full rewrites of topics/memory files |
| **User-profile protection** | ✅ Automated loops never write `USER.md`; profile suggestions recorded in episodes |
| **Negative claims rejected** | ✅ FR-004 anti-patterns bind both loops (transient failures, one-offs) |

---

## Project Structure (Real Paths)

### Phase 0: Unified Scheduler Engine + Migration (PREREQUISITE)
```
src/lib/scheduler/engine.ts               # NEW — Unified Job Engine (single daemon, single store)
src/lib/scheduler/migrate.ts              # NEW — one-time integration-polling migration
src/lib/scheduler/acl.ts                  # NEW — category-based ACL helpers
src/apps/scheduler/                       # NEW/UPDATE — unified list UI with category badges
src/lib/integrations/**                   # MODIFY — every integration that self-polls stops
                                          # self-scheduling; registers integration-category
                                          # JobDefinitions in the unified store instead
/Documents/System/scheduler-jobs.json     # VFS — unified store (created on first run)
/Documents/System/scheduler-history/*.jsonl  # VFS — per-job history
```

**Deliverable**: One engine, one file (`/Documents/System/scheduler-jobs.json`), three categories co-resident; legacy integration configs migrated; Scheduler UI shows all jobs with category badges. This is the foundation memory loops (and any future scheduled subsystem) build on.

### Phase 1: Episode Store + Fast Loop Refactor
```
src/lib/agent/memory/episodes.ts          # NEW (writes under /Documents/Memory/Episodes/)
src/lib/agent/memory/fast-loop.ts         # NEW (extracts from review.ts)
src/lib/agent/review.ts                   # MODIFY (delegates to fast-loop for automated path)
prompts/fast-loop-system.md               # NEW
```

**Deliverable**: Manual trigger via `skill_reflect` works; episodes written correctly.

### Phase 2: Fast Loop System Job + Watermarks
```
src/lib/agent/memory/fast-loop.ts         # ADD watermark logic; register `memory.fast-loop`
                                          # internal handler with engine; call ensureSystemJob
                                          # on boot to seed 'system:memory.fast-loop' into
                                          # /Documents/System/scheduler-jobs.json
src/lib/agent/memory/watermarks.ts        # NEW (sidecar at /Documents/Memory/.watermarks.json)
src/lib/config/registry.ts                # MODIFY (add memoryLoops namespace)
```

**Deliverable**: Fast loop runs every 2 min automatically via the unified engine; watermarks survive restarts. No new files under `src/lib/integrations/scheduler/`.

### Phase 3: Slow Loop + Topics
```
src/lib/agent/memory/consolidate.ts       # NEW — logic + register `memory.slow-loop` internal
                                          # handler + call ensureSystemJob on boot to seed
                                          # 'system:memory.slow-loop' into the unified store
src/lib/agent/memory/topics.ts            # NEW (writes under /Documents/Memory/Topics/)
prompts/slow-loop-system.md               # NEW
/Documents/Memory/.consolidate.lock       # VFS — overlap lock (created at runtime)
```

**Deliverable**: Episodes consolidated into topics; skills patched/created per gate; slow loop dispatched by the unified engine. No new files under `src/lib/integrations/scheduler/`.

### Phase 4: Search + Config + Docs
```
src/lib/agent/memory/search.ts            # NEW (searches /Documents/Memory/**)
docs/dev/memory/memory.md                 # UPDATE (document loops)
docs/dev/self-improvement/self-improvement.md  # UPDATE (note trigger-model change)
skills/recall-long-term-memory/SKILL.md   # NEW → SEED list
skills/implement-memory-loops/            # NEW (dev-time only, not seeded)
specs/discrepancies.md                    # UPDATE (003 vs 021 divergence)
```

**Deliverable**: Full feature operational; documentation updated.

---

## Design Notes

### Watermark Strategy (FR-006)
Watermarks MUST live in a sidecar file (`/Documents/Memory/.watermarks.json`) rather than the conversation JSON, because:
- The client owns `/Documents/Chats/<id>.json` and may overwrite it
- A write race could lose review progress
- Sidecar is loop-owned; concurrent fast-loop ticks serialize via watermark read-modify-write

### Episode File Naming (FR-001)
Format: `<yyyy-mm-dd>-<conversationId>.md`  
Rationale: One episode per conversation per day. If a conversation spans multiple days, the next day's review updates the same file (watermark advances), not a new file. Archive move happens at consolidation time.

### Topic Sharding (FR-012)
Per-topic budget: 4000 chars (configurable via `memoryLoops.topicBudget`)  
Index in `MEMORY.md`: One line per topic (`- <slug>: <one-line digest>`)  
Entry format: Identical to existing `MEMORY.md` entries (timestamped, bullet-listed)

### Skill Creation Gate (FR-014)
Three conditions ALL required:
1. **No existing skill** covers the task class (`skill_list` search first)
2. **Complexity threshold**: Multi-step, non-obvious ordering, or discovered pitfalls
3. **Recurrence evidence**: Same `skill-candidate` tag in ≥ 2 episodes

First occurrence → episode records `skillCandidates` tag  
Second occurrence → slow loop creates class-level skill (if conditions 1 & 2 also met)

### Overlap Lock (FR-011)
Slow-loop lock file: `/Documents/Memory/.consolidate.lock`  
Staleness expiry: 30 min (prevents wedging if daemon crashes)  
Lock content: `{ pid, startedAt, batchId }`

### Memory Search (FR-017)
Initial implementation: Case-insensitive word match + match-count ranking  
No new dependencies; ranking logic isolated for future BM25 swap  
Provenance returned: `source: "topics/<slug>.md#entry-3"` or `source: "episodes/2026-07-05-abc123.md#lessons"`

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Fast loop fires too often, causing LLM cost | Debounce: skip if < 4 new turns (FR-005); configurable idle threshold |
| Slow loop processes corrupted episode | Validate episode schema before consolidation; skip malformed with log entry |
| Topic file exceeds budget | Rejection + fallback to creating new topic shard (e.g., `gmail-workflows-2.md`) |
| Skill patch corrupts existing skill | Atomic write + rollback on validation failure; patch diff logged |
| Watermark desyncs from actual messages | On startup, scan for watermarks > max message index; reset to last valid |

---

## Testing Strategy

### Unit Tests
- `episodes.test.ts`: Atomic writes, injection scanning, watermark persistence
- `fast-loop.test.ts`: Eligibility logic, watermark advancement, episode update idempotency
- `consolidate.test.ts`: Topic entry ops, skill patch/creation gate, deduplication
- `search.test.ts`: Substring match, ranking, provenance format

### Integration Tests
- Fast loop runs on scheduler tick; produces episode within 2×tick interval
- Slow loop processes pending episodes; marks them consolidated; topics updated
- Crash recovery: stale lock expires; half-consolidated episodes reprocessed correctly

### Acceptance Scenarios (from spec)
All User Stories 1–4 and Edge Cases validated via end-to-end test suite in `tests/memory-loops/`

---

## Dependencies & Ordering

| Step | Depends On | Blocks |
|------|------------|--------|
| **Phase 0 (Unified Job Engine + integration-config migration)** | **None (prerequisite for everything below)** | **Phase 2, Phase 3 (any phase that seeds a JobDefinition)** |
| Phase 1 (episodes + fast-loop refactor) | None (can run in parallel with Phase 0, but must not seed a JobDefinition until Phase 0 lands) | Phase 2 |
| Phase 2 (fast-loop System JobDefinition + watermarks) | Phase 0 + Phase 1 | None (shippable MVP) |
| Phase 3 (slow loop + topics + slow-loop JobDefinition) | Phase 0 + Phase 1 | Phase 4 |
| Phase 4 (search + config + docs) | Phase 3 | Feature complete |

**Phase 0 covers the migration of existing integration polling** into the unified store (scheduler spec FR-016). Without Phase 0, memory loops cannot register themselves in the unified scheduler; without the migration, the unified store is not the sole source of truth. Both are non-negotiable prerequisites.

**MVP Shippable After Phase 2** (given Phase 0 is in): Fast loop runs automatically via the unified engine, writes episodes. Slow loop can be manually triggered via API for initial testing.

---

## Open Questions

1. **Idle threshold default**: Spec says 5 min; confirm this is appropriate for typical conversation cadence?
2. **Episode archive age**: Spec says 14 days; should this be configurable per user workflow volume?
3. **Topic sharding strategy**: When does a topic split into `_2`? Fixed count (e.g., 5 shards) or budget-based?

These are answered in the `clarify` step if needed; otherwise defaults apply as written in spec.
