# Memory subsystem

Spec: `specs/002-memory/spec.md`. User‑facing: `docs/usage/memory/how-memory-works.md`.

Two durable, curated surfaces, **injected** into the assistant's instructions as a
**frozen snapshot** at conversation start.

---

## Storage (`src/lib/agent/memory/curated.ts`, server‑only)

- `data/memory/USER.md` — the **user profile** (who you are). Budget **1200** chars.
- `data/memory/MEMORY.md` — **agent memory** (the assistant's notes). Budget **2000**
  chars.

Each file is a list of short bullet entries. Helpers: `readUser()`, `readMemory()`,
`memorySnapshot()` (builds the injected blocks), `addEntry(target, content)`,
`replaceEntry`, `removeEntry`, and a batch `applyMemoryOps(ops)`.

- **Atomic writes** via temp‑file + rename.
- **Budget enforcement:** an add/replace that would exceed the budget is **rejected**
  (not truncated); the error tells the agent to **consolidate** first. `apply
  MemoryOps` lets it remove/replace several entries and add the new one in one atomic
  batch.
- **Injection‑safety:** new entries are scanned for prompt‑injection patterns
  (`looksLikeInjection`) and refused — because this text becomes part of the
  system prompt.

---

## The memory tool (`src/lib/agent/memory/tool.ts`)

`MEMORY_LLM_TOOL` is an `LlmTool` (for the review/server loops) exposing the same
ops (`add`/`replace`/`remove`, batched). The client‑facing equivalent is the
`memory_save` action (`MemoryActions.tsx`) → `/api/memory`. `memory_recall` reads the
**live** entries (vs. the frozen snapshot in the prompt).

---

## Injection into instructions

`composeInstructions()` ([Assistant overview](../assistant/overview.md)) embeds
`memorySnapshot()` after the conversation's agent personality. The snapshot is captured
**once per conversation**, so:

- mid‑session writes persist to disk immediately, but
- they only influence behavior from the **next** conversation (stable within a chat).

---

## Memory vs. skills (don't mix)

- **Memory** = *who you are* + *current situation* (durable, always‑on, bounded).
- **Skills** = *how to do a class of task* (on‑demand procedures). See
  [Self‑improvement](../self-improvement/self-improvement.md).

The [review pass](../self-improvement/self-improvement.md) routes durable
preferences/details → memory and reusable procedure/style lessons → skills, and is
explicitly told **not** to harden transient/environment‑specific failures into
memory.

---

## Memory loops (spec 021)

Two automated scheduler jobs replace the voluntary `skill_reflect` model of
spec 003 and add an episodic buffer between reflection and long-term memory:

- **Fast loop** (`src/lib/agent/memory/fast-loop.ts`) — runs every ~2 min as a
  `system` JobDefinition (`system:memory.fast-loop`) in the unified scheduler.
  Scans `/Documents/Chats/*.json`, picks conversations idle ≥ 5 min or with
  ≥ 40 unreviewed turns, and reviews only the slice after the watermark
  (`/Documents/Memory/.watermarks.json`). Toolset restricted to
  `episode_write` and `skill_patch` (no `skill_create`, no writes to USER.md /
  MEMORY.md / topics). Output: one episode file per conversation per day at
  `/Documents/Memory/Episodes/<yyyy-mm-dd>-<convId>.md`.
- **Slow loop** (`src/lib/agent/memory/consolidate.ts`) — runs hourly as
  `system:memory.slow-loop`. Overlap-locked at
  `/Documents/Memory/.consolidate.lock` (30-min staleness expiry). Loads
  pending episodes oldest-first, applies incremental ops only
  (`memory_add_entry`, `memory_replace_entry`, `memory_remove_entry`,
  `topic_create`, `skill_patch`, and gated `skill_create`), then marks each
  processed episode `consolidated` and archives files older than
  `memoryLoops.episodeArchiveAgeDays` (default 14) into `.Archive/`.
- **Topics** (`src/lib/agent/memory/topics.ts`) — long-term memory shards at
  `/Documents/Memory/Topics/<slug>.md`. Per-topic budget 4000 chars (config
  `memoryLoops.topicBudget`). `MEMORY.md` stays the always-injected index —
  one line per topic (`- <slug>: <digest>`).
- **Watermarks** (`src/lib/agent/memory/watermarks.ts`) — sidecar JSON so the
  loops don't race the client-owned conversation files.

Both loops respect `hasCredentials()` and no-op when no AI provider is
configured. Both are seeded into `/Documents/System/scheduler-jobs.json` on
first `installBuiltInHandlers()` call via `ensureSystemJob(...)` — there is no
parallel scheduler persistence for memory.

### Skill creation gate (FR-014)

`consolidate.ts` gates `skill_create` with all three of: no existing skill
covers the class (checked via `skill_list`); complexity threshold (≥ 3
`- ` / `1.` step markers AND ≥ 200 chars of body); recurrence evidence (≥ 2
matching `skill-candidate` tags across every episode file). A first-occurrence
skill create is refused and the current episode is tagged instead.

### Retrieval

- `memory_search(query, maxResults?)` — case-insensitive substring/word match
  over `Topics/**/*.md` and `Episodes/**/*.md`, ranked by token match count.
  Provenance returned as `<path>#<anchor>` (`#entry-N` for topics,
  `#<section-slug>` for episodes). Ranking is isolated in `search.ts` so BM25
  can drop in without an interface change.
- `memory_recall(topic?)` — extended: with a slug it returns that topic
  shard's entries; without arguments it returns USER + MEMORY + the list of
  topic slugs.

### Config (`memoryLoops` namespace)

Exposed via Settings → Memory Loops. Fields: `fastLoop.enabled`,
`fastLoop.tickIntervalSec`, `fastLoop.idleThresholdSec`, `fastLoop.turnCap`,
`fastLoop.minNewTurns`, `slowLoop.enabled`, `slowLoop.intervalSec`,
`slowLoop.batchSize`, `modelOverride`, `episodeArchiveAgeDays`, `topicBudget`.

### Manual triggers

- `POST /api/memory/consolidate` — run the slow loop now.
- `POST /api/assistant/reflect` with `{ conversationId }` — run the fast loop
  now for one conversation (idle threshold waived).

---

## API (`/api/memory`)

- **GET** → `{ user: string[], memory: string[], topics: string[] }`.
- **GET** `?target=user|memory` → `{ target, entries }`.
- **GET** `?topic=<slug>` → `{ topic, digest, entries: [{ id, text, timestamp }] }`.
- **POST** `{ target:"user"|"memory", action:"add"|"replace"|"remove", content, … }`.
- **DELETE** `?target=&text=`.
- **GET** `/api/memory/search?q=<query>&maxResults=<n>` → `{ query, results: [{ source, content, score }] }`.

The Memory app (`src/apps/memory/index.tsx`) is a thin UI over this.
