# Skill: Implement Memory Loops

**Purpose**: Build procedure for the Developer sub-agent to implement spec 021-memory-loops

**Usage**: This skill is installed into `data/skills/` during the implementation phase. It is NOT seeded at runtime (dev-time only). Where this skill conflicts with the spec, the spec wins.

---

## Overview

This feature implements two automated **system** JobDefinitions seeded into the Unified Job Engine (`src/lib/scheduler/engine.ts`), each backed by an internal handler:
1. **Fast Loop** (`memory.fast-loop`, every ~2 min): Reviews idle conversations, writes episode files
2. **Slow Loop** (`memory.slow-loop`, hourly): Consolidates episodes into long-term memory topics and patches/creates skills

Both jobs live alongside every other scheduled task in `/Documents/System/scheduler-jobs.json`; run history is appended to `/Documents/System/scheduler-history/<jobId>.jsonl`. Memory loops MUST NOT create their own scheduler config, sidecar, or "derived view" — the unified store is the only persistence.

Key architectural changes from spec 003:
- Voluntary `skill_reflect` trigger → automated scheduler jobs
- Direct LTM writes → episodic buffer (episodes/) → consolidation pipeline
- Single MEMORY.md file → topic-sharded storage with incremental ops only

---

## Implementation Steps

Follow the tasks in `specs/021-memory-loops/tasks.md`. This skill provides additional implementation detail for each module.

### Step 1: Episode Store (`src/lib/agent/memory/episodes.ts`)

**Pattern**: Copy atomic write + injection scan from `src/lib/agent/memory/curated.ts`

```typescript
interface Episode {
  conversationId: string;
  createdAt: string;      // ISO timestamp
  updatedAt: string;      // ISO timestamp
  watermark: string;      // Last reviewed message ID
  skillsUsed: string[];   // Mechanical capture from telemetry
  status: 'pending' | 'consolidated';
  skillCandidates?: string[];  // Task-class slugs for recurrence tracking
  
  // Body sections (populated by fast-loop LLM)
  taskOutcome?: string;
  whatWorked?: string[];
  whatFailed?: string[];
  corrections?: string[];
  durableLessons?: string[];
  profileSuggestions?: string[];
}

// File path: /Documents/Memory/Episodes/<yyyy-mm-dd>-<conversationId>.md (VFS)
// Format: Markdown with frontmatter
```

**Key Functions**:
- `createEpisode(conversationId)`: Atomic write (temp + rename), injection-scanned
- `updateEpisode(conversationId, updates)`: Idempotent; one file per conv per day
- `getEpisode(conversationId)`: Read episode or null
- `markEpisodeConsolidated(conversationId)`: Update status field
- `archiveOldEpisodes(olderThanDays = 14)`: Move to `/Documents/Memory/Episodes/.Archive/` (never delete)

**Testing**: Verify atomicity, injection rejection, idempotency across multiple updates.

---

### Step 2: Watermarks (`src/lib/agent/memory/watermarks.ts`)

**Why sidecar?**: Client owns `/Documents/Chats/<id>.json`; watermark must live in agent-owned file to avoid write races.

```typescript
interface WatermarkStore {
  [conversationId: string]: {
    messageId: string;      // Last reviewed message ID
    reviewedAt: string;     // ISO timestamp
  };
}

// File path: /Documents/Memory/.watermarks.json (VFS)
```

**Key Functions**:
- `getWatermark(conversationId)`: Return last reviewed message ID or null
- `setWatermark(conversationId, messageId)`: Atomic write
- `resetWatermark(conversationId)`: Clear watermark (force re-review)

**Startup validation**: Scan for watermarks > max message index; reset to last valid.

---

### Step 3: Fast Loop (`src/lib/agent/memory/fast-loop.ts`)

**Eligibility Logic** (FR-005):
A conversation is eligible if ALL of these hold:
1. Has messages beyond its watermark
2. AND (idle ≥ threshold OR unreviewed turns ≥ cap OR conversation closed)
3. AND has ≥ 4 new turns (debounce trivial exchanges)

**Idle calculation**: `now - file.mtime` or `now - lastMessage.timestamp`

**LLM Toolset** (restricted):
- `episode_write(updates)`: Create/update episode sections
- `skill_patch(skillId, correction)`: ONLY if skill explicitly corrected

**NOT available**: `skill_create`, memory ops, topic ops, file writes

**System prompt**: Embed `prompts/fast-loop-system.md` verbatim as constant.

**Scheduler wiring** (no separate job file!):
- Export an internal handler function (e.g., `runFastLoop()`) and register it with the engine's handler registry under `memory.fast-loop`.
- On boot, call `ensureSystemJob(...)` from `src/lib/scheduler/engine.ts` to seed the JobDefinition into `/Documents/System/scheduler-jobs.json`:
  - `id: 'system:memory.fast-loop'`, `category: 'system'`, `owner: 'memory'`
  - `handler: { kind: 'internal', ref: 'memory.fast-loop' }`
  - `scheduleType: 'recurring'`, `scheduleConfig: { interval: 2, unit: 'minute' }`
  - `readOnlyFields: ['handler', 'category']`
- **Do NOT** create `src/lib/integrations/scheduler/jobs/memory-fast-loop.ts` or any parallel scheduler config file — the unified store is the only persistence.

---

### Step 4: Topics (`src/lib/agent/memory/topics.ts`)

**Entry format** (same as MEMORY.md):
```markdown
## Topic: gmail-workflows

- [2026-07-05] Gmail API requires OAuth scope `https://www.googleapis.com/auth/gmail.modify` for label operations
- [2026-07-06] Files app renames duplicates with (1) suffix; use `drive_files_search` to avoid collisions
```

**Key Functions**:
- `getOrCreateTopic(slug)`: Create topic file if not exists
- `addTopicEntry(topicSlug, entry)`: Append; enforce budget (4000 chars default)
- `replaceTopicEntry(topicSlug, entryId, newContent)`: Supersession semantics
- `removeTopicEntry(topicSlug, entryId)`: Delete entry
- `updateMemoryIndex(slug, digest)`: Add/update one-line in MEMORY.md

**Budget enforcement**: If topic at limit, reject + suggest new shard (e.g., `gmail-workflows-2`).

---

### Step 5: Consolidation (`src/lib/agent/memory/consolidate.ts`)

**Lock file format**:
```json
{
  "pid": 12345,
  "startedAt": "2026-07-05T14:30:00Z",
  "batchId": "consolidate-20260705-143000"
}

// File path: /Documents/Memory/.consolidate.lock (VFS)
// Staleness expiry: 30 min
```

**Skill Creation Gate** (FR-014) - ALL conditions required:
1. **No existing skill**: Call `skill_list()` and search for matching task class
2. **Complexity threshold**: Multi-step, non-obvious ordering, or discovered pitfalls
3. **Recurrence evidence**: Same `skill-candidate` tag in ≥ 2 episodes

**First occurrence**: Tag episode with `skill-candidate: <task-class>`  
**Second occurrence**: Check conditions 1 & 2; if met, create skill

**LLM Toolset** (incremental ops only):
- `memory_add_entry`, `memory_replace_entry`, `memory_remove_entry`
- `topic_create`
- `skill_patch`, `skill_create` (gated!)
- `episode_mark_consolidated`, `episode_tag_candidate`

**System prompt**: Embed `prompts/slow-loop-system.md` verbatim as constant.

**Scheduler wiring** (no separate job file!):
- Export an internal handler function (e.g., `runSlowLoop()`) and register it with the engine's handler registry under `memory.slow-loop`.
- On boot, call `ensureSystemJob(...)` from `src/lib/scheduler/engine.ts` to seed the JobDefinition into `/Documents/System/scheduler-jobs.json`:
  - `id: 'system:memory.slow-loop'`, `category: 'system'`, `owner: 'memory'`
  - `handler: { kind: 'internal', ref: 'memory.slow-loop' }`
  - `scheduleType: 'recurring'`, `scheduleConfig: { interval: 1, unit: 'hour' }`
  - `readOnlyFields: ['handler', 'category']`
- Handler body exits immediately if no pending episodes (zero LLM cost when idle) and respects the overlap lock at `/Documents/Memory/.consolidate.lock`. Failure isolation comes from the engine.
- **Do NOT** create `src/lib/integrations/scheduler/jobs/memory-slow-loop.ts` or any parallel scheduler config file.

---

### Step 6: Search (`src/lib/agent/memory/search.ts`)

**Initial implementation** (no new dependencies):
- Case-insensitive word match
- Rank by match count
- Return provenance: `{ source: "/Documents/Memory/Topics/<slug>.md#entry-3", content, score }`

**Isolate ranking logic**: Structure so BM25 can replace substring match later without interface change.

```typescript
interface SearchResult {
  source: string;      // e.g., "topics/gmail-workflows.md#entry-3"
  content: string;
  score: number;
}

async function memory_search(query: string, maxResults = 10): Promise<SearchResult[]>
```

---

### Step 7: Scheduler Seeding (Unified Job Engine)

Memory loops do **not** ship as standalone job files. The Unified Job Engine (`src/lib/scheduler/engine.ts`, Phase 0 prerequisite) owns the tick loop, persistence, failure isolation, and run-history for every scheduled job. Memory loops just:

1. **Register internal handlers** with the engine's handler registry:
   - `memory.fast-loop` → `runFastLoop()` from `src/lib/agent/memory/fast-loop.ts`
   - `memory.slow-loop` → `runSlowLoop()` from `src/lib/agent/memory/consolidate.ts`
2. **Seed JobDefinitions on boot** via `ensureSystemJob(def: JobDefinition)` exported from `src/lib/scheduler/engine.ts`. Both jobs use:
   - `category: 'system'`, `owner: 'memory'`
   - `handler: { kind: 'internal', ref: 'memory.<fast|slow>-loop' }`
   - `readOnlyFields: ['handler', 'category']`
   - Defaults: fast = every 2 min, slow = every 1 hour (users may adjust interval per category ACL)
3. **Persist nothing else.** No `src/lib/integrations/scheduler/jobs/memory-*.ts`, no sidecar scheduler file, no "derived view" of scheduler state. `/Documents/System/scheduler-jobs.json` is the sole store; `/Documents/System/scheduler-history/<jobId>.jsonl` is the sole run log.
4. **Interval config** in `memoryLoops.fastLoop.tickInterval` / `memoryLoops.slowLoop.interval` is applied by the engine via the standard editable-fields path (`getEditableFields(job)`); memory-loops code does not re-implement scheduling.

Log seeding at INFO on first boot, DEBUG on subsequent boots (already-seeded).

---

### Step 8: Config Namespace

**File**: `src/lib/config/registry.ts`

Register `memoryLoops` namespace with fields:
```typescript
{
  fastLoop: {
    enabled: true,
    tickInterval: 120,        // seconds
    idleThreshold: 300,       // seconds (5 min)
    turnCap: 40               // unreviewed turns before forced review
  },
  slowLoop: {
    enabled: true,
    interval: 3600,           // seconds (1 hour)
    batchSize: 10             // episodes per run
  },
  modelOverride?: string,     // optional per-loop model override
  episodeArchiveAge: 14       // days before archiving consolidated episodes
}
```

Expose in Settings UI under "Memory Loops" tab.

---

## Testing Checklist

### Unit Tests
- [ ] `episodes.test.ts`: Atomic writes, injection scanning, idempotency
- [ ] `watermarks.test.ts`: Persistence, validation, reset logic
- [ ] `fast-loop.test.ts`: Eligibility logic, watermark advancement, episode updates
- [ ] `topics.test.ts`: Entry ops, budget enforcement, supersession
- [ ] `consolidate.test.ts`: Lock file, batch processing, skill gate
- [ ] `search.test.ts`: Substring match, ranking, provenance format

### Integration Tests
- [ ] Fast loop runs on scheduler tick; produces episode within 2×tick interval
- [ ] Slow loop processes pending episodes; marks them consolidated
- [ ] Topic files updated incrementally; no full rewrites
- [ ] Skill creation gate enforced; recurrence evidence required
- [ ] Crash recovery: stale lock expires; half-consolidated episodes reprocessed

### Acceptance Scenarios
Validate all User Stories 1–4 from spec:
- [ ] Story 1: Reflection happens without user action
- [ ] Story 2: Long conversations reviewed in bounded chunks
- [ ] Story 3: Skills evolve conservatively from recurring experience
- [ ] Story 4: LTM grows beyond injected budget via topic sharding

---

## Common Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Writing to USER.md in automated loops | Fast/slow loop toolsets don't include USER.md write capability |
| Full file rewrites of topics/memory | Use only `memory_add_entry`, `memory_replace_entry` ops; no raw file writes |
| Creating skill from single occurrence | Enforce FR-014 gate: check recurrence evidence before allowing `skill_create` |
| Watermark write race with client | Store watermarks in sidecar file, not conversation JSON |
| Slow loop overlap (two runs at once) | Lock file with staleness expiry (30 min); check before processing |
| Injection attacks via episode content | Scan all writes via `looksLikeInjection()`; refuse suspicious content |

---

## References

- Code touchpoints: See `references/code-touchpoints.md` for per-file design detail
- Spec: `specs/021-memory-loops/spec.md` (source of truth)
- Plan: `specs/021-memory-loops/plan.md` (technical context)
- Tasks: `specs/021-memory-loops/tasks.md` (detailed checklist)

---

## Success Criteria

After implementation:
1. Fast loop runs every 2 min automatically; episodes written within threshold + 2×tick
2. Slow loop runs hourly; consolidates pending episodes; zero cost when idle
3. No skill created from single occurrence; recurrence evidence required
4. Topic files grow incrementally; no full rewrites; budget enforced
5. All 003 anti-pattern rules hold across both loops

Run `npm test` and verify all memory-loops tests pass. Then run acceptance scenario validation manually.
