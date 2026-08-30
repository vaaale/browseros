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
- **Budget enforcement (soft, 028-memory-curation-retrieval):** for the per-agent
  **topic** shards (`topics.ts`), an add/replace that would push a topic over its
  budget **succeeds** and sets a `consolidate` flag on that topic instead of being
  rejected — see [Soft budget](#soft-budget--consolidation-flag) below. `apply
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

### Agent self-edit (028-memory-curation-retrieval, T6)

Both `src/lib/agent/memory/tool.ts` (`makeMemoryTools`, used by self-improve and
local sub-agents) and `src/lib/assistant/tools/server/memory.ts` (the live
main-assistant tools) additionally expose:

- `memory_replace(topic, entryIdOrText, content)` — update an existing topic
  entry's text in place, keyed by id or a unique text substring. If the new
  text duplicates another entry already in the topic, the entry being replaced
  is dropped and the pre-existing duplicate is kept (FR-004). Unknown entry →
  a clear error, no change.
- `memory_remove(topic, entryIdOrText)` — delete an entry, same keying.

This is what lets the agent tidy a topic it has filled instead of forking a
`-2` shard — see [Soft budget](#soft-budget--consolidation-flag).

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

### Soft budget + consolidation flag (028-memory-curation-retrieval, T1/T2)

`addTopicEntry`/`replaceTopicEntry` in `topics.ts` no longer hard-reject an
over-budget write. Instead the entry is written and the topic's `consolidate`
flag is set — the save always succeeds (SC-001; this is the fix for the
originally-reported "Over budget … create a shard" failure). The flag is an
HTML-comment marker line (`<!-- needs-consolidation -->`) directly under the
digest in the topic `.md` file — invisible to `rebuildMemoryIndex` (which only
reads the first `> ` line) and excluded from the reported budget usage
(`currentBudget` subtracts exactly the marker line's length, so flagging never
moves the usage percentage the UI shows).

The slow loop (`consolidate.ts`) is the only thing that clears the flag, and
only after successfully reorganizing the topic:

- `runSlowLoop`'s per-agent gating was widened (the **M1** fix) — it now runs
  a pass when an agent has pending episodes **or** at least one flagged topic
  (`listFlaggedTopicSlugs`), so a topic flagged purely by a soft-budget
  overflow (which creates no episode) is still picked up, not silently
  skipped forever.
- For each flagged topic, `consolidateFlaggedTopic` runs a dedicated tool-loop
  pass (independent of any episode) with four new ops: `topic_read` (the full
  entry list, ids, timestamps, lifecycle state — not just the slug+digest the
  preamble shows), `topic_set_digest` (refresh the digest), `topic_supersede`
  (see [Lifecycle](#lifecycle-active--superseded-028-memory-curation-retrieval-t4)),
  and `topic_clear_consolidate` (called only once the model has finished
  reorganizing — or decided the topic needs no changes).
- Reorganization is expressed as **sequences of the existing atomic
  single-entry ops** — merge = `topic_remove_entry`×N + `topic_add_entry`×1;
  split = `topic_create` (sibling) + `topic_add_entry`×N (add to destination
  FIRST) + `topic_remove_entry`×N (then remove from source). There is
  deliberately **no whole-file rewrite op** (the ACE anti-collapse rule) — an
  interrupted pass can leave an intermediate-but-consistent state (source
  shrunk, sibling partially populated), which is valid: no entry is ever lost
  or duplicated, and the flag survives in the source file so the next hourly
  pass converges.

### Skill creation gate (FR-014)

`consolidate.ts` gates `skill_create` with all three of: no existing skill
covers the class (checked via `skill_list`); complexity threshold (≥ 3
`- ` / `1.` step markers AND ≥ 200 chars of body); recurrence evidence (≥ 2
matching `skill-candidate` tags across every episode file). A first-occurrence
skill create is refused and the current episode is tagged instead.

### Retrieval — hybrid dense + sparse ranking (028-memory-curation-retrieval, T3)

- `memory_search(query, maxResults?)` — ranks candidates (topic entries +
  episode lines) by a **fused score**:
  `0.4·dense + 0.3·sparse(BM25) + 0.2·recency + 0.1·importance`, renormalized
  over whatever signals are actually available for that candidate. Dense is
  cosine similarity against an embedding (see
  [Embeddings](#embeddings--provider-endpoint-028-memory-curation-retrieval-t3)
  below); sparse is a lightweight in-memory BM25 (k1=1.5, b=0.75) over the
  candidate corpus, max-normalized per search; recency is
  `exp(-age_days/30)` (neutral `0.5` when the timestamp is missing/unparsable
  — episodes derive it from the filename's date prefix); importance has no
  computed source yet, so it's always the neutral `0.5` fallback (FR-017).
  Results are gated by a **relevance floor**: a candidate needs
  `max(dense, sparse) ≥ 0.15` of real lexical/semantic support to rank at all
  — below that (or when nothing clears it) the result is empty rather than a
  low-confidence guess (FR-014). Provenance is unchanged: `<path>#<anchor>`
  (`#entry-N` for topics — the entry's real index in the topic, `#<section
  -slug>` for episodes). Each result also carries `state` (`"active"` or
  `"superseded"`) so a stale hit is labeled, not presented as current.
- **Graceful degradation (FR-016):** when the provider can't serve embeddings
  (blank embedding model, an Anthropic-only provider with no override, or the
  endpoint's `/embeddings` call fails), the dense term is dropped and the
  fused score renormalizes over sparse + recency + importance — no error, no
  crash (SC-007).
- **Bounded cold-cache cost:** dense similarity is only computed for the
  **top-K (≈10) sparse-ranked topic candidates** on a cold cache (episodes
  never get a dense term — they have no stable per-entry id to cache
  against). This caps a cold search at one query embed + ≤K corpus embeds;
  once cached, subsequent searches reuse the stored vectors.
- `memory_recall(topic?, asOf?)` — extended: with a slug it returns that topic
  shard's entries, labeling superseded ones "not current"; without arguments
  it returns preferences + the topic index. `asOf='<yyyy-mm-dd>'` re-derives
  each entry's state as of that historical date instead of now (FR-020).

### Embeddings — provider endpoint (028-memory-curation-retrieval, T3)

The AI Provider config (`src/lib/agent/provider.ts`) grows an `embeddings?: {
baseUrl?, apiKey?, model? }` sub-config, resolved by `resolveEmbeddingConfig`
with **per-field fallback**: an empty `baseUrl`/`apiKey` falls back to the
LLM provider's own value; `model` is independent (no fallback — blank ⇒
embeddings disabled, per FR-010). `getProviderConfigView()` exposes only the
resolved, non-secret `embedBaseUrl`, a `hasEmbeddingKey` boolean (never the
key itself — FR-011), the raw `embedModel`, and `embeddingsEnabled`.
`provider-meta.ts` carries the per-provider `defaultEmbedModel` (OpenAI family
→ `text-embedding-3-small`; local/Responses → none, user-picked) and an
inferred `embedAvailability` (`anthropic` → `"unsupported"` unless the user
points the embedding base URL at a separate OpenAI-compatible server).

`llm.ts`'s `embed(resolved, text)` calls the `openai` SDK's
`.embeddings.create` against the resolved endpoint (it works against any
OpenAI-compatible `/embeddings` route, not just OpenAI itself) and returns
`null` — not a thrown error — on any failure (404/auth/unsupported); this
`null` is the degradation signal `search.ts` and `embeddings.ts` branch on.
`src/lib/agent/memory/embeddings.ts` wraps `embed()` with a per-agent cache at
`/Memories/<agentId>/.embeddings.json`, keyed by the entry's content-hash id —
because the id **is** a hash of the entry's clean text, a text edit produces a
new id, so cache invalidation on text change falls out by construction
(FR-013); a model change is caught by comparing the cached entry's recorded
`model` against the currently-resolved one. Settings → AI Provider surfaces
this as an **Embeddings** subsection (`ProviderSettings.tsx`) with per-field
hints, a has-key/fallback indicator, and an availability badge updated by
**Test connection** (never auto-probed).

### Lifecycle (active / superseded) (028-memory-curation-retrieval, T4)

A `TopicEntry` carries an optional `state: "active" | "superseded"` and, when
superseded, a `supersededBy: { id, timestamp }` reference to the entry that
replaced it — persisted as an inline `⟦superseded by=<id>@<timestamp>⟧` tag on
the entry line (absent ⇒ active). The entry's id is a hash of its **clean**
text with the tag stripped first, so tagging/untagging never changes the id.
A pre-existing text-regex heuristic (`(superseded YYYY-MM-DD)` in the entry
text) is kept as a **read-time fallback** for topic files written before this
tag existed.

`supersedeTopicEntry(agentId, slug, entryIdOrText, supersededBy)` marks an
entry superseded **without deleting it** (FR-018) — the slow loop's new
`topic_supersede` op exposes this, guided by a "contradiction detection"
section in the system prompt: while reading a topic (or extracting a new
lesson), the model watches for two entries on the same subject that can't
both be true and supersedes the older one. This is best-effort background
judgment, not an inline rule — until a pass runs, both entries stay visible
with the newer one preferred. `entryStateAt(entry, asOf)` computes the
as-of view: active iff the entry existed by `asOf` and (if superseded) the
superseding entry hadn't yet appeared by `asOf` either.

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
- **GET** `/api/memory/search?q=<query>&maxResults=<n>` → `{ query, results: [{ source, content, score, state }] }` — `score` is the fused dense+sparse+recency+importance score (see [Retrieval](#retrieval--hybrid-dense--sparse-ranking-028-memory-curation-retrieval-t3)); `state` is `"active"` or `"superseded"`.

---

## User interface

The primary way for a human to manage every memory surface is the **Memory
app** (`src/apps/memory/`). It's a thin UI over the API above and the memory
loops:

- **Profile & Notes tab** — `USER.md` / `MEMORY.md` with per-file budget bars.
- **Episodes tab** — pending vs. consolidated episodic files, with manual
  *Review Now* / *Archive* / *Delete* actions.
- **Topics tab** — per-topic shards with entry-level add/delete and per-topic
  budget bars.
- **Memory Loops tab** — the `memoryLoops` config namespace exposed as a form,
  plus run-history from the central log and manual-trigger buttons for both
  loops (wired to `POST /api/memory/consolidate` and `POST /api/assistant/reflect`).
- **Search tab** — cross-surface search over Topics + Episodes + MEMORY.md via
  `/api/memory/search`.

Every tab is composed as one component under `src/apps/memory/components/`,
loaded by `src/apps/memory/index.tsx`. When extending memory functionality,
mirror the change in the appropriate tab so the user has a way to see and
control it. For end-user documentation of the app, see
[docs/usage/apps/memory.md](../../usage/apps/memory.md).
