# Tasks: Memory Loops (Episodic Fast Loop & Consolidating Slow Loop)

**Feature**: 021-memory-loops  
**Status**: Ready for Implementation  
**Branch**: `bos/memory-loops`

---

## Phase 0: Universal Scheduler Refactor (Prerequisite)

Memory Loops depends on the **Unified Job Engine** described in `bos-system-specs/scheduler/spec.md`. Phase 0 delivers that engine and migrates existing integration polling into its single store. Nothing in Phase 1+ can ship until Phase 0 lands, because the fast/slow loops are registered as System-category JobDefinitions in the unified store — there is no separate scheduler persistence for the memory subsystem.

### Task 0.1: Implement the Unified Job Engine
- [ ] **File**: `src/lib/scheduler/engine.ts`
- [ ] Implement single background daemon that manages all JobDefinitions from **one** source of truth: `/Documents/System/scheduler-jobs.json` (VFS path; user-accessible; atomic writes).
- [ ] Define `JobDefinition` type (mirror scheduler spec FR-002): `id`, `name`, `category: 'system' | 'user' | 'integration'`, `handler: { kind: 'prompt' | 'internal' | 'integration', ...}`, `scheduleType`, `scheduleConfig`, `status`, `nextRunAt`, `createdAt`, `updatedAt`, optional `owner`, optional `readOnlyFields`.
- [ ] Persistence layer: load-on-boot, atomic write-through on mutation, re-read on external file change (watch/poll). All categories share this one file — NO split persistence.
- [ ] Handler registry: register `prompt` (agent runtime), `internal` (function map), `integration` (integration adapter dispatch). Failure isolation across handlers and across jobs.
- [ ] Run-history: append every execution to `/Documents/System/scheduler-history/<jobId>.jsonl`.
- [ ] Central logging with `component: 'scheduler'`, always include `category` and `handler.kind`.
- [ ] Startup: run migration (Task 0.5) before entering the main tick loop; seed System JobDefinitions requested by the codebase (Task 0.3); then start ticking.

**Acceptance**: One engine, one file, three categories co-resident; failure isolation verified; history appended per job.

---

### Task 0.2: Migrate Existing Integration Polling to Register into the Engine
- [ ] **Files**: existing integration polling call sites under `src/lib/integrations/**` (whichever currently owns the polling schedule)
- [ ] Update every integration that currently self-schedules polling so that instead of running its own loop / config, it:
  - Registers an `integration`-category JobDefinition in the unified store with a stable id (`integration:<integrationId>:<action>`).
  - Exposes its polling function through the engine's `integration` handler dispatch (integration id + action → adapter call).
  - Reads its schedule state (interval, active/paused) from the unified store, NOT from its own config file. If the user pauses it via the Scheduler UI, the change is reflected in the unified store and honored on the next tick.
- [ ] Remove any code path that reads a per-integration polling config at runtime; the only remaining reader of legacy paths is the migration script (Task 0.5), which runs once and then never again.
- [ ] **Do not** implement a "derived view" that keeps legacy config as source of truth — the unified store is authoritative; integrations that add jobs at install time write directly into it.

**Acceptance**: No integration self-schedules; all polling flows through the engine's tick; pausing/editing an integration job in the Scheduler UI takes effect immediately.

---

### Task 0.3: System-Job Seeding API
- [ ] **File**: `src/lib/scheduler/engine.ts` (extend) — export `ensureSystemJob(def: JobDefinition): Promise<JobDefinition>`
- [ ] Idempotent by stable id (e.g., `system:memory.fast-loop`, `system:memory.slow-loop`, or `system:<subsystem>.<name>`): if the id already exists in the unified store, do NOT overwrite user-modifiable fields (interval, status) — only refresh the immutable ones (handler, name, `readOnlyFields`, `category: 'system'`).
- [ ] Callers: subsystems (like memory loops) invoke this on boot to declare their System-category JobDefinitions. The engine picks them up on the next tick without a restart.

**Acceptance**: Re-seeding a system job on every boot is a no-op after the first boot; user's schedule adjustments to System jobs (where category ACL allows) survive re-seeding.

---

### Task 0.4: Category-Based ACL Enforcement Surface
- [ ] **File**: `src/lib/scheduler/engine.ts` (extend) — export `getEditableFields(job: JobDefinition): string[]` that returns which fields the UI may allow edits on, driven by category defaults (scheduler spec FR-017) and overridden by the job's own `readOnlyFields`.
- [ ] Server-side write API (`updateJob(id, patch)`) MUST validate the patch against `getEditableFields`; reject with a clear error if the caller attempts to modify a locked field.
- [ ] ACL enforcement is at the engine layer, not the UI — a rogue MCP tool call cannot delete a System job even if the UI would prevent it.

**Acceptance**: System jobs cannot be deleted via any API; integration jobs' handler/target cannot be edited via the UI or MCP tools; user jobs have full control.

---

### Task 0.5: One-Time Migration Script (Legacy Integration Configs → Unified Store)
- [ ] **File**: `src/lib/scheduler/migrate.ts`
- [ ] On first startup after the unified-engine upgrade, scan for legacy integration polling configurations (previously stored per-integration under `data/integrations/**` or in the config registry — whichever the current codebase uses).
- [ ] For each discovered polling config, synthesize an `integration`-category JobDefinition with:
  - `id = 'integration:<integrationId>:<action>'` (stable, deterministic — this makes the migration idempotent)
  - `category: 'integration'`, `handler: { kind: 'integration', integrationId, action }`
  - Preserved `scheduleConfig`, `status`, `nextRunAt` (falling back to `now + interval` if the legacy state is incomplete)
  - `owner: <integrationId>` and reasonable `readOnlyFields` (e.g., `['handler']`).
- [ ] Write all migrated jobs into `/Documents/System/scheduler-jobs.json` in a single atomic write. Existing entries (user-created or previously-migrated) are preserved and never overwritten.
- [ ] Mark migration done by writing `_meta.migratedSources: [<sourcePath>...]` into the unified store's top-level object (or rename each legacy source with `.migrated` suffix). Subsequent boots skip already-migrated sources.
- [ ] Ambiguity handling: if two legacy configs describe the same `integration:<integrationId>:<action>` with conflicting schedules, HALT that one entry (do NOT choose silently), log the conflict at ERROR level, surface it via scheduler status, and continue with other entries.
- [ ] Log a final summary: `{ scanned, migrated, skipped_already_migrated, conflicts }`.
- [ ] Idempotency test: running the migration twice on a clean upgrade produces zero writes on the second run.

**Acceptance**: All existing integrations appear as `integration`-category jobs in `/Documents/System/scheduler-jobs.json` after first boot; second boot is a no-op; conflicts halt gracefully with clear diagnostics.

---

### Task 0.6: Scheduler App UI — Unified List with Category Badges
- [ ] **File**: existing/new Scheduler app (under `src/apps/scheduler/` or the current location)
- [ ] Render all JobDefinitions from `/Documents/System/scheduler-jobs.json` — regardless of category — in a single list, sorted by `nextRunAt`.
- [ ] Each row shows a `category` badge (System / User / Integration).
- [ ] Row actions gated by `getEditableFields()` from Task 0.4: user rows show full CRUD; system rows hide Delete and prompt-edit; integration rows hide handler-edit and Delete.
- [ ] "Schedule New Task" button only creates `category: 'user'` jobs.

**Acceptance**: Users can view and manage jobs from **all** categories from one interface, with per-category UI restrictions applied at the engine layer.

---

**Phase 0 done ⇒ Phase 1 unblocked.** From this point on, both memory loops (and any future scheduled subsystem) simply call `ensureSystemJob(...)` on boot to seed their JobDefinition into the unified store; they never own their own scheduling persistence.

---

## Phase 1: Episode Store + Fast Loop Refactor

### Task 1.1: Create Episode Module
- [ ] **File**: `src/lib/agent/memory/episodes.ts`
- [ ] Implement `Episode` type with frontmatter fields:
  - `conversationId`, `createdAt`, `updatedAt`, `watermark`
  - `skillsUsed: string[]`, `status: 'pending' | 'consolidated'`
  - `skillCandidates: string[]` (optional)
- [ ] Implement `EpisodeBody` sections:
  - Task & outcome, What worked / what failed, Corrections received
  - Durable lesson candidates, Profile suggestions
- [ ] Implement `createEpisode(conversationId: string): Promise<Episode>`
  - Atomic write (temp file + rename) to `/Documents/Memory/Episodes/<yyyy-mm-dd>-<conversationId>.md` (VFS path)
  - Injection scan via `looksLikeInjection()`; reject if suspicious
- [ ] Implement `updateEpisode(conversationId: string, updates: Partial<EpisodeBody>): Promise<Episode>`
  - Idempotent: one file per conversation per day
  - Preserve existing sections, merge new content
- [ ] Implement `getEpisode(conversationId: string): Promise<Episode | null>`
- [ ] Implement `markEpisodeConsolidated(conversationId: string): Promise<void>`
- [ ] Implement `archiveOldEpisodes(olderThanDays: number = 14): Promise<number>`
  - Move to `/Documents/Memory/Episodes/.Archive/` (never delete)
- [ ] Write unit tests: `tests/memory/episodes.test.ts`

**Acceptance**: Episodes created/updated atomically; injection-scanned; idempotent per conversation.

---

### Task 1.2: Create Watermark Persistence
- [ ] **File**: `src/lib/agent/memory/watermarks.ts`
- [ ] Implement watermark data structure: `{ [conversationId: string]: { messageId: string, reviewedAt: string } }`
- [ ] Persist to `/Documents/Memory/.watermarks.json` (atomic writes)
- [ ] Implement `getWatermark(conversationId: string): Promise<string | null>`
- [ ] Implement `setWatermark(conversationId: string, messageId: string): Promise<void>`
- [ ] Implement `resetWatermark(conversationId: string): Promise<void>`
- [ ] Add startup validation: scan for watermarks > max message index; reset to last valid

**Acceptance**: Watermarks survive restarts; no write races with client-owned conversation files.

---

### Task 1.3: Extract Fast Loop Logic
- [ ] **File**: `src/lib/agent/memory/fast-loop.ts`
- [ ] Define `FastLoopConfig` interface (tickInterval, idleThreshold, turnCap)
- [ ] Implement `scanEligibleConversations(): Promise<ConversationRef[]>`
  - Scan `/Documents/Chats/*.json` via VFS
  - Filter: messages beyond watermark AND (idle ≥ threshold OR unreviewed turns ≥ cap OR conversation closed)
  - Skip if < 4 new turns (debounce trivial exchanges)
- [ ] Implement `reviewConversation(convRef: ConversationRef): Promise<EpisodeUpdate>`
  - Extract transcript slice after watermark
  - Call LLM with restricted toolset (`episode_write`, `skill_patch` only)
  - System prompt from bundled `prompts/fast-loop-system.md` (embed verbatim as constant)
  - Capture `skillsUsed` mechanically from telemetry/transcript tool calls
- [ ] Implement `runFastLoop(): Promise<RunSummary>`
  - Process eligible conversations sequentially
  - Create/update episodes; advance watermarks
  - Log run (start, processed count, episodes created/updated, refusals)
- [ ] Remove `skill_create` from fast-loop toolset; keep only `episode_write`, `skill_patch`
- [ ] Write unit tests: `tests/memory/fast-loop.test.ts`

**Acceptance**: Fast loop reviews only new turns; writes episodes correctly; no skill creation.

---

### Task 1.4: Create Fast Loop System Prompt
- [ ] **File**: `prompts/fast-loop-system.md`
- [ ] Write system prompt with these constraints:
  - Role: "You are the fast-loop reviewer, analyzing recent conversation turns"
  - Scope: Only turns after the watermark; do not re-review old content
  - Output: Update episode sections (Task/outcome, lessons, corrections)
  - Restrictions: NO skill creation, NO writes to USER.md/MEMORY.md/topics
  - Anti-patterns: Ignore transient failures, negative tool claims, one-off narratives
  - Tool usage: `episode_write` for updates; `skill_patch` only if skill explicitly corrected
- [ ] Embed as constant in `fast-loop.ts`: `export const FAST_LOOP_SYSTEM_PROMPT = /* verbatim file content */`

**Acceptance**: Prompt embedded verbatim; LLM respects restrictions.

---

### Task 1.5: Refactor review.ts to Delegate
- [ ] **File**: `src/lib/agent/review.ts`
- [ ] Modify `runReview()` to detect automated vs manual invocation
- [ ] For automated path (called by scheduler): delegate to `fast-loop.ts` logic
- [ ] Keep `skill_reflect` as manual trigger: "run fast loop now for this conversation"
- [ ] Update documentation comments

**Acceptance**: `skill_reflect` still works manually; automated reviews use fast-loop module.

---

## Phase 2: Fast Loop Scheduler + Watermarks

### Task 2.1: Seed the Fast-Loop System JobDefinition into the Unified Store
- [ ] **File**: `src/lib/agent/memory/fast-loop.ts` (extend) — expose an internal handler `memory.fast-loop` and register it with the engine's handler registry (Task 0.1).
- [ ] On boot, call `ensureSystemJob(...)` from `src/lib/scheduler/engine.ts` (Task 0.3) to seed a JobDefinition into `/Documents/System/scheduler-jobs.json`:
  - `id: 'system:memory.fast-loop'`
  - `category: 'system'`, `owner: 'memory'`
  - `handler: { kind: 'internal', ref: 'memory.fast-loop' }`
  - `scheduleType: 'recurring'`, `scheduleConfig: { interval: 2, unit: 'minute' }` (default; user may adjust interval per category ACL)
  - `readOnlyFields: ['handler', 'category']`
- [ ] **Do NOT** create a `src/lib/integrations/scheduler/jobs/memory-fast-loop.ts` or any parallel scheduler config file — the unified store is the ONLY persistence for this job.
- [ ] The engine's tick + failure isolation come from Task 0.1; this task just seeds the job.
- [ ] Log seeding at INFO on first boot, DEBUG on subsequent boots (already-seeded).

**Acceptance**: Fast loop appears in `/Documents/System/scheduler-jobs.json` as a `system` job after first boot; runs every 2 min via the unified engine; visible in the Scheduler UI with the System badge (user cannot delete it).

---

### Task 2.2: Add memoryLoops Config Namespace
- [ ] **File**: `src/lib/config/registry.ts`
- [ ] Register new namespace: `memoryLoops`
- [ ] Define fields:
  - `fastLoop.enabled` (boolean, default true)
  - `fastLoop.tickInterval` (number, default 120 seconds)
  - `fastLoop.idleThreshold` (number, default 300 seconds / 5 min)
  - `fastLoop.turnCap` (number, default 40 unreviewed turns)
  - `slowLoop.enabled` (boolean, default true)
  - `slowLoop.interval` (number, default 3600 seconds / 1 hour)
  - `slowLoop.batchSize` (number, default 10 episodes per run)
  - `modelOverride` (string, optional; per-loop model override)
  - `episodeArchiveAge` (number, default 14 days)
- [ ] Expose in Settings UI under "Memory Loops" tab
- [ ] Add agent tools for reading/updating config

**Acceptance**: Config visible in Settings; agent can read/update via tools.

---

### Task 2.3: Update Discrepancies Documentation
- [ ] **File**: `specs/discrepancies.md`
- [ ] Document divergence from spec 003:
  - 003 used voluntary `skill_reflect` trigger; 021 uses automated scheduler jobs
  - 021 introduces episodic store (episodes/) as buffer before consolidation
  - 021 adds topic sharding for long-term memory growth beyond MEMORY.md budget
- [ ] Note that GEPA (Pass 2) and Curator (Pass 3) remain unchanged

**Acceptance**: Spec drift documented; developers understand the model change.

---

## Phase 3: Slow Loop + Topics

### Task 3.1: Create Topics Module
- [ ] **File**: `src/lib/agent/memory/topics.ts`
- [ ] Implement `TopicEntry` type (timestamped bullet-listed content)
- [ ] Implement `getOrCreateTopic(slug: string): Promise<Topic>`
  - Create `/Documents/Memory/Topics/<slug>.md` if not exists
  - Parse existing entries from file
- [ ] Implement `addTopicEntry(topicSlug: string, entry: TopicEntry): Promise<void>`
  - Append to topic file; enforce budget (default 4000 chars)
  - Rejection + fallback to new shard if budget exceeded
- [ ] Implement `replaceTopicEntry(topicSlug: string, entryId: string, newContent: string): Promise<void>`
  - Supersession semantics: mark old entry as superseded, add new
- [ ] Implement `removeTopicEntry(topicSlug: string, entryId: string): Promise<void>`
- [ ] Implement `updateMemoryIndex(slug: string, digest: string): Promise<void>`
  - Add/update one-line entry in `MEMORY.md` (budget enforced)
- [ ] Write unit tests: `tests/memory/topics.test.ts`

**Acceptance**: Topic files grow incrementally; no full rewrites; budget enforced.

---

### Task 3.2: Create Consolidate Module
- [ ] **File**: `src/lib/agent/memory/consolidate.ts`
- [ ] Define `ConsolidateConfig` interface (interval, batchSize)
- [ ] Implement `acquireLock(): Promise<Lock | null>`
  - Create `/Documents/Memory/.consolidate.lock` with pid/start time
  - Check for stale locks (>30 min); expire if needed
  - Return null if lock held by another process
- [ ] Implement `releaseLock(lock: Lock): Promise<void>`
- [ ] Implement `loadPendingEpisodes(batchSize: number): Promise<Episode[]>`
  - Oldest-first ordering; batch-limited
- [ ] Implement `consolidateEpisode(episode: Episode): Promise<ConsolidationResult>`
  - Call LLM with restricted toolset (memory_add_entry, memory_replace_entry, topic_create, skill_patch, skill_create gated)
  - System prompt from bundled `prompts/slow-loop-system.md` (embed verbatim)
  - Process ops incrementally; mark episode consolidated only after success
- [ ] Implement `runSlowLoop(): Promise<RunSummary>`
  - Acquire lock; exit if none available
  - Process pending episodes in batch; log each op
  - Release lock; archive old episodes
- [ ] Write unit tests: `tests/memory/consolidate.test.ts`

**Acceptance**: Slow loop runs hourly; processes episodes oldest-first; lock prevents overlap.

---

### Task 3.3: Create Slow Loop System Prompt
- [ ] **File**: `prompts/slow-loop-system.md`
- [ ] Write system prompt with these constraints:
  - Role: "You are the consolidation engine, merging episodic memories into long-term knowledge"
  - Input: Pending episode(s) with task/outcome/lessons
  - Output: Incremental ops only (`memory_add_entry`, `topic_create`, `skill_patch`, gated `skill_create`)
  - Skill creation gate (FR-014): Require recurrence evidence (≥ 2 episodes) + complexity threshold
  - Anti-patterns: Never harden transient failures, negative claims, one-off narratives
  - Deduplication: Supersede contradictory entries; do not append duplicates
- [ ] Embed as constant in `consolidate.ts`: `export const SLOW_LOOP_SYSTEM_PROMPT = /* verbatim file content */`

**Acceptance**: Prompt embedded verbatim; LLM respects incremental ops and skill gate.

---

### Task 3.4: Seed the Slow-Loop System JobDefinition into the Unified Store
- [ ] **File**: `src/lib/agent/memory/consolidate.ts` (extend) — expose an internal handler `memory.slow-loop` and register it with the engine's handler registry (Task 0.1).
- [ ] On boot, call `ensureSystemJob(...)` from `src/lib/scheduler/engine.ts` (Task 0.3) to seed a JobDefinition into `/Documents/System/scheduler-jobs.json`:
  - `id: 'system:memory.slow-loop'`
  - `category: 'system'`, `owner: 'memory'`
  - `handler: { kind: 'internal', ref: 'memory.slow-loop' }`
  - `scheduleType: 'recurring'`, `scheduleConfig: { interval: 1, unit: 'hour' }` (default; user may adjust)
  - `readOnlyFields: ['handler', 'category']`
- [ ] **Do NOT** create a `src/lib/integrations/scheduler/jobs/memory-slow-loop.ts` or any parallel scheduler config file — the unified store is the ONLY persistence for this job.
- [ ] Handler body exits immediately if no pending episodes (zero LLM cost when idle) and respects the overlap lock at `/Documents/Memory/.consolidate.lock` (Task 3.2). Failure isolation comes from the engine (Task 0.1).

**Acceptance**: Slow loop appears in `/Documents/System/scheduler-jobs.json` as a `system` job; runs hourly via the unified engine; zero cost when no pending episodes; overlap lock respected; visible in the Scheduler UI with the System badge (user cannot delete it).

---

### Task 3.5: Implement Skill Creation Gate
- [ ] **File**: `src/lib/agent/memory/consolidate.ts` (extend)
- [ ] Before allowing `skill_create`, validate all three conditions (FR-014):
  1. **No existing skill**: Call `skill_list()` and search for matching task class
  2. **Complexity threshold**: Check episode for multi-step, non-obvious ordering, or discovered pitfalls
  3. **Recurrence evidence**: Search episode files for matching `skill-candidate` tags (≥ 2 occurrences)
- [ ] If any condition fails: reject skill creation; log reason; record `skill-candidate` tag on episode instead
- [ ] Add helper: `searchSkillCandidates(taskClass: string): Promise<number>` (count matching episodes)

**Acceptance**: No skill created from single occurrence; recurrence evidence required.

---

## Phase 4: Search + Config + Docs

### Task 4.1: Create Memory Search Module
- [ ] **File**: `src/lib/agent/memory/search.ts`
- [ ] Implement `memory_search(query: string, maxResults: number = 10): Promise<SearchResult[]>`
  - Scan `/Documents/Memory/Topics/**/*.md` and `/Documents/Memory/Episodes/**/*.md` (via VFS)
  - Case-insensitive word match; rank by match count
  - Return provenance: `{ source: "/Documents/Memory/Topics/<slug>.md#entry-3", content: "...", score: number }`
- [ ] Isolate ranking logic for future BM25 swap (no interface change)
- [ ] No new dependencies; substring/word match only
- [ ] Write unit tests: `tests/memory/search.test.ts`

**Acceptance**: Search returns matching entries with provenance; ranked by relevance.

---

### Task 4.2: Extend memory_recall for Topics
- [ ] **File**: `src/lib/agent/memory/curated.ts` (modify)
- [ ] Extend `memory_recall(slug?: string)` to handle topic slugs
- [ ] If slug provided: return entries from `/Documents/Memory/Topics/<slug>.md`
- [ ] If no slug: existing behavior (global memory)

**Acceptance**: Topic retrieval via `memory_recall("gmail-workflows")` works.

---

### Task 4.3: Create Recall Long-Term Memory Skill
- [ ] **File**: `skills/recall-long-term-memory/SKILL.md`
- [ ] Write skill teaching assistant to use `memory_search` and `memory_recall`
- [ ] Include examples: "Search for lessons about Gmail workflows", "Recall the gmail-workflows topic"
- [ ] Add to SEED list in `src/lib/agent/skills/store.ts` (`created_by: seed`)

**Acceptance**: Skill seeded; fresh installs include it; existing installs can add via Build Studio.

---

### Task 4.4: Create Implement Memory Loops Skill (Dev-Time Only)
- [ ] **File**: `skills/implement-memory-loops/SKILL.md`
- [ ] Write build procedure for developer sub-agent
- [ ] Include references to code touchpoints (`references/code-touchpoints.md`)
- [ ] List per-file design details (atomic writes, watermark strategy, lock file format)
- [ ] Install into `data/skills/` during implementation; NOT seeded at runtime

**Acceptance**: Developer has detailed build procedure; spec is source of truth if conflicts.

---

### Task 4.5: Update Documentation
- [ ] **File**: `docs/dev/memory/memory.md`
  - Document episodic store (episodes/, watermarks)
  - Explain fast loop vs slow loop roles
  - Show topic sharding strategy and budget enforcement
- [ ] **File**: `docs/dev/self-improvement/self-improvement.md`
  - Note trigger-model change: voluntary → automated scheduler jobs
  - Document skill creation gate (FR-014)
- [ ] **File**: `docs/usage/memory.md` (user-facing, if exists)
  - Explain automatic reflection; no user action required
  - Describe what gets saved (lessons, corrections) vs what doesn't (transient failures)

**Acceptance**: Docs reflect new architecture; users understand automation.

---

### Task 4.6: Create API Endpoints
- [ ] **File**: `src/api/memory.ts` (or extend existing)
- [ ] `POST /api/memory/consolidate`: Manual slow-loop trigger (for debugging/testing)
- [ ] Extend `POST /api/assistant/reflect`: Manual fast-loop trigger for specific conversation
- [ ] Both endpoints log to central logging; return run summary

**Acceptance**: Manual triggers available for testing; mirror Curator on-demand pattern.

---

## Testing & Verification

### Integration Tests
- [ ] **File**: `tests/memory-loops/fast-loop-integration.test.ts`
  - Fast loop runs on scheduler tick; produces episode within 2×tick interval
  - Watermark advances correctly; re-review is idempotent
- [ ] **File**: `tests/memory-loops/slow-loop-integration.test.ts`
  - Slow loop processes pending episodes; marks them consolidated
  - Topic files updated incrementally; skills patched/created per gate
- [ ] **File**: `tests/memory-loops/crash-recovery.test.ts`
  - Stale lock expires; half-consolidated episodes reprocessed correctly

### Acceptance Scenario Validation
Validate all User Stories from spec:
- [ ] Story 1: Reflection happens without user action (fast loop → episode → consolidation)
- [ ] Story 2: Long conversations reviewed in bounded chunks (turn cap)
- [ ] Story 3: Skills evolve conservatively (gate enforcement)
- [ ] Story 4: LTM grows beyond injected budget (topic sharding)

### Success Criteria Verification
- [ ] SC-001: 100% of conversations with ≥ 4 turns have episode within threshold + 2×tick
- [ ] SC-002: Unchanged conversations trigger zero LLM calls; idempotent reviews
- [ ] SC-003: Pending episodes consolidated within interval + run duration; idle = zero cost
- [ ] SC-004: No skill from single occurrence; skills used are re-examined
- [ ] SC-005: Topics never shrink by more than one entry; no full rewrites
- [ ] SC-006: 003 anti-patterns enforced across both loops

---

## Implementation Order (Recommended)

0. **Phase 0** (Tasks 0.1–0.6): Unified Job Engine + integration-config migration + Scheduler UI unified list → **PREREQUISITE** — nothing memory-loops-specific can ship without this.
1. **Phase 1** (Tasks 1.1–1.5): Episode store + fast-loop refactor → Manual trigger works
2. **Phase 2** (Tasks 2.1–2.3): Seed fast-loop System JobDefinition + watermarks → Fast loop runs automatically via the unified engine (**MVP shippable, given Phase 0**)
3. **Phase 3** (Tasks 3.1–3.5): Slow loop + topics + skill gate + slow-loop JobDefinition seeded into the unified store → Full consolidation pipeline
4. **Phase 4** (Tasks 4.1–4.6): Search + docs + API → Feature complete

Each phase past Phase 0 is independently testable and shippable.

---

## Notes for Developer

- **Unified persistence**: All scheduled jobs — System, User, Integration — live in `/Documents/System/scheduler-jobs.json`. Memory loops MUST NOT create a parallel scheduler config file, a per-loop persistence sidecar, or a "derived view" of integration jobs. Seed via `ensureSystemJob(...)` and stop.
- **Memory artifacts live under `/Documents/Memory/`** (VFS): episodes at `/Documents/Memory/Episodes/`, topics at `/Documents/Memory/Topics/`, watermarks at `/Documents/Memory/.watermarks.json`, overlap lock at `/Documents/Memory/.consolidate.lock`, archive at `/Documents/Memory/Episodes/.Archive/`. No `data/memory/**` paths.
- **Atomic writes**: Use temp-file + rename pattern from `curated.ts`; all episode/topic ops must follow this
- **Injection safety**: Every write to episodes/topics/MEMORY.md scanned via `looksLikeInjection()`; refused content logged and dropped. **Improvements to injection detection are a deliberate non-goal for this feature** — rely on the existing scanner.
- **No npm dependencies**: Search uses substring/word match; ranking logic isolated for future BM25 swap
- **Feature branch**: `bos/memory-loops` (confirm active before starting)
- **TypeScript**: `npx tsc --noEmit` clean required; do not run `npm run build` while `next dev` is live
- **Prompts are normative**: Embed system prompts verbatim from bundled files; any wording change requires spec update first
