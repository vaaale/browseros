# Tasks: Context Compaction (Layered Conversation Compactification)

**Feature**: 022-context-compaction
**Status**: Ready for Implementation
**Branch**: `bos/bos-conversation-compaction` (worktree branch; spec suggests `bos/context-compaction`)

Reference: `022-context-compaction-spec.md`, `plan.md`, `prompts/compaction-summary-system.md`.

Global constraints (apply to every task):
- **No new npm dependencies.** `wrapLanguageModel` / `transformParams` ship with `ai` v6.
- **No edits to `package.json` / lockfiles / build config.**
- **Every phase MUST end with** `npx tsc --noEmit` **and** `npm run lint` **clean.**
- Do **not** run `npm run build` while `next dev` is live (shared `.next`).
- The client-owned transcript at `/Documents/Chats/<id>.json` is **never** written by this feature.

---

## Phase 1: Estimation + View Transform + Layer 1 + Route Wiring

Deliverable: Below-threshold conversations pass through byte-identically (SC-002). Tool-heavy conversations crossing `clearThreshold` see older tool-results collapsed to one-line placeholders in stable, watermarked batches (SC-003).

### Task 1.1: Token Estimator (pure, isolated)
- [ ] **File**: `src/lib/agent/compaction/estimate.ts` (NEW)
- [ ] Export `estimateTokens(messages: LanguageModelV2Prompt): number` implementing `ceil(totalChars / 4)` over serialized message content (roles + text parts + tool-call/tool-result payloads serialized as JSON strings).
- [ ] Export `estimateBudget({ maxInputTokens, maxTokens, assumedContextTokens }): number` returning the effective budget = `(maxInputTokens ?? assumedContextTokens) - (maxTokens ?? DEFAULT_MAX_TOKENS)`. Guard against negative results.
- [ ] Keep the heuristic **isolated behind the exported functions** so a real tokenizer can drop in later without an interface change (FR-001).
- [ ] No dependencies outside `ai` types.

**Acceptance**: Unit test covers empty messages, unicode payloads, tool parts serialized correctly. `estimateBudget` reserves output headroom.

---

### Task 1.2: Sidecar Store (atomic, hash-validated, lockable)
- [ ] **File**: `src/lib/agent/compaction/sidecar.ts` (NEW)
- [ ] Define the sidecar type (plan.md § "Sidecar shape"):
  ```
  { boundary: { count: number, spanHash: string } | null,
    summary: string | null,
    clearWatermark: number,
    lock: { acquiredAt: string, owner: string } | null,
    updatedAt: string,
    stats: { estimatedTokens: number, compactedAt: string, runs: number } }
  ```
- [ ] Sidecar path: `data/memory/compaction/<convId>.json`. Ensure directory exists on first write.
- [ ] Implement:
  - `readSidecar(convId): Promise<Sidecar | null>` — returns null on ENOENT; other errors bubble.
  - `writeSidecar(convId, sidecar): Promise<void>` — temp-file + rename atomic write (reuse the pattern from `src/lib/agent/memory/curated.ts`).
  - `computeSpanHash(messages): string` — SHA-256 hex of the JSON-serialized message array up to the boundary; imported from Node `crypto` (built-in).
  - `acquireLock(convId, opts?: { stalenessMs?: number }): Promise<Sidecar | null>` — returns the sidecar with the lock taken, or `null` if a fresh lock is held. Expires stale locks (older than `stalenessMs`, default 600000) — when expiring, log `lock.expired`.
  - `releaseLock(convId): Promise<void>`.
  - `deleteSidecar(convId): Promise<void>` — used by GC.
  - `validateSummary(text: string): boolean` — wrap `looksLikeInjection` from `src/lib/agent/memory/injection.ts`; return `false` if suspicious.
- [ ] **Do NOT** persist a summary that fails `validateSummary` — return early and log `summary.refused`.

**Acceptance**: Unit tests cover atomic write (no partial file on simulated crash), lock acquisition + staleness expiry, hash-mismatch discard path, injection-scan refusal.

---

### Task 1.3: Pure View Transform (Layer 1 only)
- [ ] **File**: `src/lib/agent/compaction/view.ts` (NEW)
- [ ] Export `applyView(messages, sidecar, config): { messages, transformed: boolean, stats }` — a **pure** function.
- [ ] Layer 1 (clear-watermark) semantics:
  - Walk the message array from the end backwards, identifying the newest `config.keepToolResults` (default 5) tool-use/result pairs; every tool-result at an index **older than** those pairs and **older than** `sidecar.clearWatermark` gets its content replaced by a single-line placeholder: `"<tool_result:name>output elided to save context — re-run the tool if the output is needed again</tool_result:name>"`. Tool-name is taken from the paired tool-call.
  - Preserve tool-call parts (assistant side) verbatim; do not touch message ordering (FR-004).
  - Tools listed in `config.unrecoverableTools` are never cleared (FR-006).
- [ ] Boundary walking helpers (used by Layer 2 in Phase 3, but authored here):
  - `findTailStart(messages, minTailMessages, tailBudgetFraction, budget): number` — computes cut so the kept tail is `max(tailBudgetFraction × budget, minTailMessages)`, then walks the cut back so (a) no tool group is split and (b) the cut lands on a **user** message (FR-008). Returns the index where the tail begins.
- [ ] Below `config.clearThreshold * budget`: return `{ messages, transformed: false }` byte-identically (SC-002). Do NOT create the sidecar directory.
- [ ] Above `config.clearThreshold * budget` but no watermark advance needed (i.e., already at or beyond the desired watermark): return the transformed view but do not mutate the sidecar.
- [ ] Export a `shouldAdvanceClearWatermark(messages, sidecar, config, budget): boolean` predicate the middleware uses to decide when to write.
- [ ] **Do NOT** mutate the sidecar in this file. All I/O lives in the middleware.

**Acceptance**: Unit tests cover pair-safety at boundaries, tail-starts-at-user rule (including the walk-back one-more-step case), byte-identity below threshold, unrecoverable-tools carve-out. Every test asserts message ordering unchanged.

---

### Task 1.4: Middleware Wrapper (Layer 1 wiring)
- [ ] **File**: `src/lib/agent/compaction/middleware.ts` (NEW)
- [ ] Export `withCompaction(model: LanguageModelV2, convId: string): LanguageModelV2` using `wrapLanguageModel` from `ai` v6 with a `transformParams` middleware.
- [ ] Inside `transformParams`:
  1. Read `params.prompt` (the message array), `params.maxTokens`, and provider `maxInputTokens` if exposed.
  2. Read sidecar (`readSidecar(convId)`), or synthesize a fresh empty one (do not write yet).
  3. Compute `budget = estimateBudget(...)`, `est = estimateTokens(prompt)`.
  4. Read compaction config (Task 2.2 — for Phase 1 use hard-coded defaults in this task, then swap to config reader in Phase 2).
  5. If `!config.enabled` OR `est < clearThreshold * budget`: return `params` **unchanged**. Log at DEBUG only if `est` is meaningful (to avoid log spam on discovery pings).
  6. Otherwise:
     - Call `applyView(prompt, sidecar, config)` to produce the transformed message array (Layer 1 clearing).
     - If `shouldAdvanceClearWatermark(...)` returns true: fire-and-forget `writeSidecar` with an advanced `clearWatermark` and a `clear.advance` log entry (never block the model call on this write — use `void writeSidecar(...).catch(err => log.error(...))`).
     - Return `{ ...params, prompt: transformed }`.
- [ ] Layer 2 scheduling and hard-limit fallback are **stubs** in this phase (Phase 2 / Phase 3 fill them in).
- [ ] **Never touch `params.system`** (constraint pinning invariant, FR-017).

**Acceptance**: Middleware is a total function (never throws to the caller); on any unexpected error it logs and returns `params` unchanged so the model call proceeds.

---

### Task 1.5: Wire the Middleware into the CopilotKit Route
- [ ] **File**: `src/app/api/copilotkit/route.ts` (MODIFY)
- [ ] At the existing `getLanguageModel()` call site (currently line 65), wrap the model:
  ```ts
  import { withCompaction } from "@/lib/agent/compaction/middleware";
  // …
  const rawModel = agentId ? serviceAdapter.getLanguageModel?.() : undefined;
  const model = rawModel && convId ? withCompaction(rawModel, convId) : rawModel;
  ```
- [ ] Do **not** touch any other line in this file. The composed prompt path stays untouched.
- [ ] Requests without a `conv` id remain pass-through (agent-less discovery / runtime-info pings — FR-016).

**Acceptance**: `npx tsc --noEmit` and `npm run lint` clean. Manual smoke: short conversation still responds normally; long tool-heavy conversation shows placeholder text in the request logs (dev-time inspection).

---

## Phase 2: Hard-Limit Fallback + Logging + Config Namespace

Deliverable: A conversation past `hardLimit` completes turns via a mechanical pair-safe truncation with a WARN log (SC-005). All compaction events visible in the central log. Config namespace visible in Settings and to the agent.

### Task 2.1: Compaction Config Getters
- [ ] **File**: `src/lib/agent/compaction/config.ts` (NEW)
- [ ] Export a typed `CompactionConfig` interface and `readCompactionConfig(): Promise<CompactionConfig>` that reads the `compaction` namespace from the config registry (Task 2.2). Merge with defaults from plan.md § "Config namespace".
- [ ] Validate `clearThreshold < summarizeThreshold < hardLimit`; on invalid combo, log ERROR once per process and fall back to defaults.
- [ ] Replace hard-coded defaults inside `middleware.ts` with a call to this reader (cache per request; do not read the registry N times per turn).

**Acceptance**: Config changes made via Settings take effect on the next request (no restart). Invalid combos do not crash the middleware.

---

### Task 2.2: Register the `compaction` Config Namespace
- [ ] **File**: `src/lib/config/registry.ts` (MODIFY)
- [ ] Register namespace `compaction` (FR-018) with fields:
  - `enabled` (bool, default `true`)
  - `assumedContextTokens` (int, default `128000`)
  - `clearThreshold` (frac in `[0,1]`, default `0.50`)
  - `summarizeThreshold` (frac in `[0,1]`, default `0.75`)
  - `hardLimit` (frac in `[0,1]`, default `0.92`)
  - `keepToolResults` (int, default `5`)
  - `keepTailMessages` (int, default `10`)
  - `tailBudgetFraction` (frac, default `0.20`)
  - `unrecoverableTools` (string[], default `[]`)
  - `model` (string, optional — summarizer override)
  - `lockStalenessMs` (int, default `600000`)
- [ ] Include per-field descriptions so the Settings UI and the agent both get useful metadata.
- [ ] Namespace registration inherits Settings-tab visibility and agent tool visibility automatically (existing registry mechanism).

**Acceptance**: Settings shows a "Compaction" section (or the namespace is available under the general config surface, matching how other namespaces render). Agent can read/update via existing config tools.

---

### Task 2.3: Central Logging Wiring
- [ ] **File**: `src/lib/agent/compaction/middleware.ts` and `sidecar.ts` (EXTEND)
- [ ] Import the central server logger (`src/lib/logging/server-logger.ts`). Every log call MUST include `component: 'compaction'`, `conv: <id>`, and token stats where relevant (`est`, `budget`, `clearWatermark`, `boundary.count`).
- [ ] Standardized events:
  - `clear.advance` (INFO)
  - `hash.invalidated` (INFO) — includes previous and current spanHash
  - `fallback.applied` (WARN) — hard-limit fallback triggered
  - `lock.expired` (WARN)
  - `middleware.error` (ERROR) — caught in the outer try/catch; always paired with pass-through fallback
- [ ] Do **not** log the message payload itself (privacy).

**Acceptance**: Grepping the central log for `component: 'compaction'` returns a coherent event stream during a synthetic long-conversation dev run.

---

### Task 2.4: Hard-Limit Fallback (Layer 3)
- [ ] **File**: `src/lib/agent/compaction/middleware.ts` (EXTEND)
- [ ] Inside `transformParams`, after Layer 1 has been applied:
  - Compute the effective estimate on the Layer-1-transformed messages.
  - If `est >= hardLimit * budget` AND there is no valid summary that would bring `est` below `hardLimit * budget` when spliced in: apply the mechanical fallback synchronously.
- [ ] Fallback algorithm (FR-011):
  - Keep the first user message verbatim.
  - Compute the largest recent tail (using `findTailStart`) that fits inside `summarizeThreshold * budget` (target is the summarize threshold, not the hard limit, so the next turn also has room).
  - Splice `[firstUserMessage] + [keptTail]`. No summary, no placeholder — just truncation. Pair-safety and tail-starts-at-user rules from `view.ts` apply.
  - Log `fallback.applied` at WARN with `est`, `budget`, and the message count before/after.
- [ ] After applying the fallback, **still schedule** Layer 2 (Phase 3) so the next turn can benefit from a real summary.
- [ ] **Never** allow a request with `est > budget` to reach the provider unchanged. A provider context-length 400 due to unmanaged growth is a spec violation (SC-005).

**Acceptance**: Integration test `hard-limit.test.ts` with the summarizer disabled: conversation past `hardLimit` completes; no provider 400; WARN log entry present.

---

## Phase 3: Layer 2 Async Summarizer + Normative Prompt + API Routes

Deliverable: Long conversations get an asynchronous, structured summary applied from the first turn after it lands. `GET`/`POST /api/compaction` exposes state and manual trigger.

### Task 3.1: Copy the Normative Prompt into the Repo
- [ ] **File**: `prompts/compaction-summary-system.md` (NEW; copy from `specs/bos-system-specs/022-context-compaction/prompts/compaction-summary-system.md`)
- [ ] The bundled version is normative (FR-013). Copy it verbatim.
- [ ] Do NOT modify wording. If wording needs to change, change the spec bundle first, then re-copy.

**Acceptance**: The two files are byte-identical after this task (`diff` clean).

---

### Task 3.2: Summarizer Job
- [ ] **File**: `src/lib/agent/compaction/summarize.ts` (NEW)
- [ ] Export `const SUMMARY_SYSTEM_PROMPT: string` — the body of `prompts/compaction-summary-system.md` embedded **verbatim** with the leading HTML comment stripped (FR-013). Prefer inline string literal or read-at-build-time (never at request-time from disk).
- [ ] Export `summarizeConversation(convId: string, opts: { manual?: boolean }): Promise<{ boundary, summary } | { skipped: true, reason: string }>`:
  1. **Acquire the lock** via `sidecar.acquireLock(convId)`. If `null`, return `{ skipped: true, reason: 'locked' }` (do not wait).
  2. Read `/Documents/Chats/<convId>.json` via `conversations-server.ts`. Compute the summarize boundary using `view.findTailStart(...)` (using current config).
  3. Compute `spanHash = computeSpanHash(spanUpToBoundary)`. If sidecar already has a valid summary at this boundary+hash, release lock and return `{ skipped: true, reason: 'already-summarized' }`.
  4. **021 fast-loop hook** (FR-014): dynamic import `src/lib/agent/memory/fast-loop`. If `runFastLoop` exists, call it with `{ conversationId: convId, waiveIdleThreshold: true, upToMessageIndex: boundary.count }`. On failure, log `fast-loop.failed` (WARN) and continue. If the module is absent, log `fast-loop.skipped` (INFO) once per conversation.
  5. Assemble the summarizer user message:
     - If a previous summary exists in the sidecar, prepend a `Previous summary:\n<text>` block (anchored update, Edge Cases).
     - Append the serialized span (oldest first).
  6. Call `complete()` from `src/lib/agent/llm.ts` with `system: SUMMARY_SYSTEM_PROMPT`, the assembled user message, and `model: config.model` (optional cheaper override). No tools allowed.
  7. Retry at most **once** on failure (any thrown error, empty output, or step-limit exhaustion). On repeat failure, log `summary.failed` (ERROR), release the lock, return `{ skipped: true, reason: 'summarizer-failed' }`.
  8. `validateSummary(text)` — if it fails, log `summary.refused` (WARN), release lock, return `{ skipped: true, reason: 'injection' }`.
  9. Write sidecar with `{ boundary, summary: text, updatedAt: now, stats.runs++ }` (atomic). Log `summary.applied` (INFO).
  10. Release lock. Return `{ boundary, summary }`.
- [ ] The function MUST be fire-and-forget safe: caller uses `void summarizeConversation(convId).catch(err => log.error(...))`.

**Acceptance**: Summarizer produces a well-formed summary against a recorded transcript; retries once on injected transient failure; declines injected-looking output.

---

### Task 3.3: Extend the View Transform to Splice Summaries
- [ ] **File**: `src/lib/agent/compaction/view.ts` (EXTEND)
- [ ] When `sidecar.summary` and `sidecar.boundary` are both present:
  - Compute `spanHash = computeSpanHash(messages.slice(0, sidecar.boundary.count))`. If it does not match `sidecar.boundary.spanHash`, treat the sidecar summary as absent (client edited history — FR-010, US-5.2). The middleware handles the discard-and-recompute (Task 3.4).
  - If it matches: construct the splice per FR-012:
    - Drop `messages[0..sidecar.boundary.count]`.
    - Prepend one user-role message with content:
      ```
      <conversation_summary>
      <SUMMARY_TEXT>

      Earlier details from this conversation were compacted. Durable lessons may be retrievable via memory_search.
      </conversation_summary>
      ```
    - Ensure the next message (first of the kept tail) is a user message; if not, walk forward one step so it is. (In practice the boundary already lands on a user message per FR-008.)
- [ ] Also apply Layer 1 clearing on the kept tail's older tool results (the two layers compose).
- [ ] Byte-identity invariant (SC-003): given identical inputs (messages, sidecar, config), output is identical. No randomness.

**Acceptance**: Unit tests cover splice shape, hash-match apply, hash-mismatch skip, combined Layer 1 + Layer 2 output, byte-identity across repeated invocations.

---

### Task 3.4: Wire Layer 2 Scheduling into the Middleware
- [ ] **File**: `src/lib/agent/compaction/middleware.ts` (EXTEND)
- [ ] After Layer 1 in `transformParams`:
  - Recompute `est` on the Layer-1-transformed messages (should be lower after clearing).
  - If `est >= summarizeThreshold * budget` AND sidecar has no valid summary for the current boundary:
    - `void summarizeConversation(convId).catch(err => log.error({ component: 'compaction', conv: convId, err }, 'summarize failed'))`. Do NOT await.
    - Log `summary.scheduled` (INFO).
- [ ] If sidecar has a summary whose `spanHash` no longer matches: delete the summary + boundary from the sidecar (`hash.invalidated` INFO log) and schedule a fresh summarization (as above).
- [ ] `hasCredentials()` false → skip Layer 2 scheduling entirely; Layer 1 and the hard-limit fallback still work.

**Acceptance**: Long-conversation dev run shows `summary.scheduled` on the first over-threshold turn, `summary.applied` shortly after (async), and subsequent turns route through the summarized view.

---

### Task 3.5: Compaction API Route
- [ ] **File**: `src/app/api/compaction/route.ts` (NEW)
- [ ] `GET /api/compaction?conv=<id>`: return the sidecar JSON verbatim (or 404 if none). Include a `boundary` count of messages replaced by the summary.
- [ ] `POST /api/compaction?conv=<id>`: force a summarization now. Response mirrors `summarizeConversation`'s return type. Requires the same permission surface as other agent-mutating endpoints (reuse whichever guard the curator on-demand endpoint uses; if none exists, gate behind a same-origin check).
- [ ] Both handlers log at INFO with `component: 'compaction'`, `conv`, and the outcome.

**Acceptance**: `curl -X GET .../api/compaction?conv=<id>` returns the sidecar; `curl -X POST` forces a run and returns the applied summary. Manual trigger visible in the central log.

---

## Phase 4: 021 Fast-Loop Hook Validation + Probe Tests + Docs

Deliverable: SC-001..SC-006 all validated; docs cross-linked; discrepancies file updated.

### Task 4.1: 021 Fast-Loop Hook — End-to-End Sanity
- [ ] **File**: `src/lib/agent/compaction/summarize.ts` (VERIFY — hook already added in Task 3.2)
- [ ] Manual verification: with 021 installed, force a summarization via `POST /api/compaction?conv=<id>` and confirm:
  - The fast-loop review runs first (episode file appears/updates under `/Documents/Memory/Episodes/`).
  - The compaction summary is written after.
  - Log stream shows the fast-loop invocation before `summary.applied`.
- [ ] With 021 disabled (e.g., temporarily rename `src/lib/agent/memory/fast-loop.ts`): confirm summarization still succeeds and `fast-loop.skipped` is logged (US-4.3).

**Acceptance**: Both branches (021 present / 021 absent) produce a valid summary; log stream matches expectation.

---

### Task 4.2: Randomized-Boundary Test (SC-001)
- [ ] **File**: `tests/compaction/randomized-boundary.test.ts` (NEW)
- [ ] Load one or two recorded tool-heavy transcripts from a fixture directory (add fixtures under `tests/compaction/fixtures/`).
- [ ] Enumerate a set of forced boundary indices covering every message position. For each:
  - Apply the view transform with the boundary at that index.
  - Assert every `tool_call` in the transformed messages has a matching `tool_result` (or vice versa) — no orphans.
  - Assert the kept tail starts at a user message.
  - Assert the transformed messages are a valid provider prompt shape for both provider families (structure-only check; do not call the provider).
- [ ] Repeat with the summary spliced in.

**Acceptance**: Zero orphan pairs across all enumerated cuts; ordering invariant holds.

---

### Task 4.3: Below-Threshold Byte-Identity Test (SC-002)
- [ ] **File**: `tests/compaction/view.test.ts` (EXTEND) or a dedicated `passthrough.test.ts`
- [ ] Build a conversation with `est < clearThreshold * budget`. Run the middleware twice, capture the transformed prompts.
- [ ] Assert `JSON.stringify(before) === JSON.stringify(after)` byte-for-byte AND the sidecar file does not exist on disk after the run.

**Acceptance**: Test passes; zero sidecar writes for below-threshold runs.

---

### Task 4.4: Cache-Preservation Test (SC-003)
- [ ] **File**: `tests/compaction/cache.test.ts` (NEW)
- [ ] Simulate two consecutive turns with no threshold crossing in between (add one message to the tail between turns).
- [ ] Hash the transformed prefix (everything except the newest message) on both turns.
- [ ] Assert hashes are equal (byte-identical prefix — proxy for prompt-cache hit).

**Acceptance**: Prefix identical between watermark/summary events.

---

### Task 4.5: Probe Tests (SC-004)
- [ ] **File**: `tests/compaction/probes.test.ts` (NEW)
- [ ] Test setup: config with `clearThreshold: 0.10`, `summarizeThreshold: 0.15`, `hardLimit: 0.25` (test-lowered per plan.md).
- [ ] **Constraint probe**:
  - Seed a conversation where the user says something like `"Standing constraint: never touch package.json for the rest of this conversation."` early.
  - Grow the conversation past `summarizeThreshold`. Force summarization.
  - Ask the assistant to do something adjacent to `package.json`. Assert the response honors the constraint (the summary's **Standing constraints** section carries it forward, FR-013).
- [ ] **Needle probe**:
  - Seed a conversation containing a specific fact (e.g., `"the customer's order ID is 3ABC-771"`).
  - Force summarization. Ask a question that requires the fact.
  - Assert the fact appears in the returned assistant message (either from the summary text OR via `memory_search` with 021 installed).
- [ ] Skip the `memory_search` branch when 021 is absent (US-4.3).

**Acceptance**: Both probes succeed under forced compaction. Failure of either is a spec violation for SC-004.

---

### Task 4.6: Hard-Limit + No-Transcript-Writes Tests (SC-005, SC-006)
- [ ] **File**: `tests/compaction/hard-limit.test.ts` (NEW; per plan.md § Testing Strategy)
- [ ] With summarizer disabled (temporary config `summarizeThreshold: 1.0` so Layer 2 never schedules), grow a conversation past `hardLimit`.
- [ ] Assert the turn completes (no provider 400) AND a `fallback.applied` WARN log entry is present.
- [ ] **File**: `tests/compaction/no-transcript-writes.test.ts` (NEW)
- [ ] Run the full compaction lifecycle (Layer 1 advance, Layer 2 summary applied, fallback) in a temp workspace.
- [ ] Assert **zero** writes to `/Documents/Chats/**` (spy on the VFS writer; assert no `write*` call whose path starts with that prefix).
- [ ] Delete the compaction sidecar directory mid-test; assert the next turn still completes (fresh sidecar is regenerated).

**Acceptance**: Both tests pass. `/Documents/Chats` is authoritative and untouched.

---

### Task 4.7: Documentation Updates
- [ ] **File**: `docs/dev/assistant/overview.md` (UPDATE)
- [ ] Add a section on context compaction:
  - Where it lives (`src/lib/agent/compaction/`), how it's wired (`route.ts` `withCompaction`).
  - The three layers and thresholds.
  - Constraint pinning invariant.
  - Cross-link `docs/dev/assistant/context-compaction-research.md` and the 021 memory-loops docs.
- [ ] **File**: `specs/bos-system-specs/discrepancies.md` (UPDATE)
- [ ] Note 022's relationship to 021: soft dependency, write-before-compaction pattern, memory_search as recovery path.
- [ ] **Do NOT** create user-facing docs unless the user asks — this is a transparent, no-user-action feature.

**Acceptance**: Overview doc links to research + this spec; discrepancies note is present.

---

## Testing & Verification

### Success Criteria (map to tests above)
- [ ] **SC-001** — Randomized-boundary tests (Task 4.2): zero orphan pairs; both provider families.
- [ ] **SC-002** — Below-threshold byte-identity (Task 4.3): zero LLM calls, zero sidecar writes, byte-identical output.
- [ ] **SC-003** — Cache preservation (Task 4.4): byte-identical prefix between compaction events.
- [ ] **SC-004** — Probes (Task 4.5): constraint honored, needle recoverable.
- [ ] **SC-005** — Hard-limit fallback (Task 4.6): no provider 400 with summarizer disabled.
- [ ] **SC-006** — Zero transcript writes (Task 4.6): `/Documents/Chats/**` untouched; sidecar discardable.

### Manual Smoke Path
1. Start `next dev`; open a fresh conversation.
2. Chat until the log shows `clear.advance` — verify tool-heavy transcripts show placeholders on subsequent turns (dev inspection).
3. Keep chatting until `summary.scheduled` then `summary.applied` appear.
4. `curl "http://localhost:3000/api/compaction?conv=<id>"` — verify sidecar view.
5. Continue the conversation; verify the assistant behaves consistently (no re-asking for established context).

---

## Implementation Order (Recommended)

1. **Phase 1** (Tasks 1.1–1.5): Estimation + view transform + Layer 1 + route wiring → below-threshold pass-through works; tool-heavy transcripts show placeholders. **First shippable slice.**
2. **Phase 2** (Tasks 2.1–2.4): Config + logging + hard-limit fallback → **MVP shippable.** No LLM cost, no crashes on overflow.
3. **Phase 3** (Tasks 3.1–3.5): Layer 2 async summarizer + normative prompt + API routes → quality-preserving summarization active.
4. **Phase 4** (Tasks 4.1–4.7): 021 hook validation + probe tests + docs → SC-001..SC-006 all locked; feature complete.

Each phase is independently testable. Ship after Phase 2 if the summarizer needs more bake time.

---

## Notes for Developer

- **Compaction is a pure view transformation.** The client-owned transcript at `/Documents/Chats/<id>.json` is NEVER written by this feature. Any test failing SC-006 is a spec violation, not a test bug.
- **The system prompt is never compacted.** `composeInstructions()` output reaches the provider unmodified. Only the `messages` (aka `prompt`) array is transformed. This is the FR-017 constraint-pinning invariant.
- **Atomic writes only.** Reuse the temp-file + rename pattern from `src/lib/agent/memory/curated.ts`. Never write the sidecar in place.
- **Injection scan the summary.** Summary text re-enters prompts on the next turn; run `looksLikeInjection` before persisting; log and drop on refusal.
- **No new npm dependencies.** `wrapLanguageModel`, `transformParams`, and `sha256` (Node `crypto`) are all built-in.
- **021 is a soft dependency.** Use `await import(...)` + feature-detect. Absence is a logged skip, never a failure.
- **Prompts are normative.** Embed `prompts/compaction-summary-system.md` verbatim as a module constant. Any wording change is a spec change made in the bundled file first.
- **Do not run `npm run build` while `next dev` is running** (shared `.next`). Use `npx tsc --noEmit` and `npm run lint` for verification.
- **The wiring point is exactly one line.** The `route.ts` edit is `const model = rawModel && convId ? withCompaction(rawModel, convId) : rawModel;`. If the diff to `src/app/api/copilotkit/route.ts` grows beyond that region, stop and reconsider.
