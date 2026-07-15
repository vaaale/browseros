# Feature Specification: Context Compaction (Layered Conversation Compactification)

**Feature Branch**: `022-context-compaction`

**Created**: 2026-07-05

**Status**: Implementation Ready (Spec, Clarify, Plan, and Tasks complete)

**Input**: "Long conversations must keep working past the model's usable context. Compaction is a server-side view transformation on what is SENT to the model — the client-owned transcript is never rewritten. Layered: (1) mechanical tool-result clearing with no LLM call, (2) asynchronous structured summarization past a threshold, (3) write-before-compaction via the memory loops so durable facts survive lossy summarization. System instructions are never compacted (constraint pinning)."

> Companion to `021-memory-loops` (episodes = write-before-compaction store; `memory_search` = post-compaction recovery path). Research basis: `docs/dev/assistant/context-compaction-research.md` — this spec implements its layered recommendation (observation masking ≈ LLM summarization at half the cost; in-context constraints decay 0%→30% violation when summarized, hence pinning; compact early, in large stable chunks, for prompt-cache friendliness).

---

## Problem

BOS has no context management at all. `ProviderConfig.maxInputTokens` is stored ("used for trimming") but read by nothing; the CopilotKit client re-sends the full message history every request; `AnthropicAdapter`/`OpenAIChatAdapter` forward it unmodified. A long or tool-heavy conversation therefore (a) degrades in quality well before the window is full (context rot), (b) grows quadratically in cost, and (c) eventually hard-fails with a provider context-length error, bricking the conversation. There is exactly one provider-agnostic choke point to fix this: `serviceAdapter.getLanguageModel()` in `/api/copilotkit/route.ts` returns an AI SDK `LanguageModel` (`ai` v6) that can be wrapped with `wrapLanguageModel({ middleware: { transformParams } })`, seeing every model call — including intra-turn tool-loop steps — for both provider families.

## Architecture Overview

```
client (owns /Documents/Chats/<id>.json — NEVER rewritten by this feature)
   │  full message history, every request
   ▼
/api/copilotkit/route.ts ── wraps model: withCompaction(model, convId)
   │
   ▼
transformParams middleware (pure view transformation, per model call)
   1. estimate tokens (chars/4, isolated module)
   2. LAYER 1 — tool-result clearing: results older than the persisted
      clear-watermark → one-line placeholder (tool-call parts kept)
   3. LAYER 2 — if a summary exists in the sidecar and its hash still
      matches: splice  [summary user-message] + [kept tail]
   4. thresholds crossed? → schedule async work (never blocks the call):
         clearThreshold  → advance clear-watermark (batch, no LLM)
         summarizeThreshold → lock + review-before-compact (021 fast loop)
                              + structured summary via complete()
         hardLimit       → synchronous mechanical fallback (pair-safe
                           keep-first + keep-last), warn
   ▼
provider (system prompt from composeInstructions() is untouched — pinned)

state: data/memory/compaction/<convId>.json   (sidecar, atomic writes)
recovery: episodes + topics via memory_search (021)
```

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A long conversation just keeps working (Priority: P1)

The user works in one conversation all day. It never hits a provider context-length error, never visibly resets, and the assistant keeps acting on the current task.

**Acceptance Scenarios**:

1. **Given** a conversation whose estimated tokens exceed the summarize threshold, **When** the async summary lands and the next turn runs, **Then** the model receives `[system prompt] [summary message] [kept recent tail]` and the response addresses the user's latest intent without re-asking for established context.
2. **Given** a conversation under the clear threshold, **When** any turn runs, **Then** the middleware makes zero LLM calls, zero sidecar writes, and passes messages through byte-identical.
3. **Given** the window would overflow before an async summary lands, **When** a turn runs, **Then** the mechanical fallback truncates (pair-safe) rather than letting the provider 400, and a warning is logged.

### User Story 2 - Tool-heavy conversations stay cheap without getting dumber (Priority: P1)

**Acceptance Scenarios**:

1. **Given** estimated tokens cross the clear threshold, **When** the clear-watermark advances, **Then** all tool results older than the keep-last-N pairs are replaced by placeholders naming the tool and how to regenerate the output, while tool-call records remain intact.
2. **Given** two consecutive turns with no threshold crossing in between, **Then** the transformed prefix (everything before the newest messages) is byte-identical across the turns — clearing happens in watermarked batches, never as a rolling window (prompt-cache preservation).
3. **Given** a tool listed in the unrecoverable-tools config, **Then** its results are never cleared.

### User Story 3 - Instructions and constraints survive compaction (Priority: P1)

**Acceptance Scenarios**:

1. **Given** any number of compactions, **Then** the system prompt (CORE_POLICY + personality + memory snapshot + skills/MCP indices) reaches the model unmodified — the middleware only ever transforms the message array.
2. **Given** a user-stated standing constraint ("never touch package.json") issued early in a conversation, **When** the span containing it is summarized, **Then** the constraint appears in the summary's **Standing constraints** section (normative prompt, FR-013) and a forced-compaction probe test verifies the assistant still honors it.

### User Story 4 - Compacted details remain recoverable (Priority: P2)

**Acceptance Scenarios**:

1. **Given** the memory loops (021) are installed, **When** a summarization is about to run, **Then** the fast-loop review is invoked first for this conversation (idle threshold waived) covering turns up to the compaction boundary, so durable lessons are on disk in an episode before the model's view is compressed.
2. **Given** a compacted conversation, **When** the assistant needs a detail from the compacted span, **Then** the summary's trailing recovery note points it at `memory_search`, and `memory_search` over episodes/topics returns matches with provenance.
3. **Given** 021 is not installed (or its module is absent), **Then** summarization still works — the review step is skipped, not failed.

### User Story 5 - The transcript stays authoritative and debuggable (Priority: P2)

**Acceptance Scenarios**:

1. **Given** any compaction activity, **Then** `/Documents/Chats/<id>.json` is never written by this feature; the UI continues to show the full history.
2. **Given** the user edits or truncates history client-side (regenerate, branch switch), **When** the span hash in the sidecar no longer matches, **Then** the stale compaction state is discarded and recomputed — never applied to mismatched messages.
3. **Given** a compaction event (clear advance, summary applied, fallback), **Then** it is visible in the central log and via `GET /api/compaction?conv=<id>` (state, thresholds, last event).

### Edge Cases

- **Tool-pair integrity**: both providers hard-400 on an assistant tool-call without its matching result. Every boundary (clear-watermark, summary boundary, fallback cut) MUST treat a tool-call message and its result message(s) as one atomic group.
- **Provider message-order validity**: the kept tail MUST begin at a user message; the summary is injected as a user-role message. Resulting prompts MUST be valid for both provider families (AI SDK conversion merges consecutive same-role messages — assert in tests, don't assume).
- **`maxInputTokens` unset**: fall back to `compaction.assumedContextTokens` (default 128000). Reserve output headroom (`maxTokens ?? DEFAULT_MAX_TOKENS`) when computing the effective budget.
- **Summarizer failure / step limit**: retry at most once per lock acquisition; on failure log and leave state unchanged (the hard-limit fallback still protects the conversation). No retry loops.
- **Summarizer output**: MUST pass `looksLikeInjection` before entering the sidecar (summary text re-enters prompts); refused output is dropped and logged.
- **Locking**: one summarization in flight per conversation; lock is a sidecar field with staleness expiry (default 10 min) so a crashed job cannot wedge the conversation.
- **Concurrent turns during summarization**: the middleware never waits on the lock; it serves the current view and the summary applies from the first turn after it lands (boundary chosen from the message span that was hashed, not "latest").
- **Repeated compaction**: anchored, never chained — a re-summarization's input is (previous summary + newly evicted span), producing one updated summary. Summaries of summaries of summaries are forbidden (drift amplification).
- **No credentials**: `hasCredentials()` false → Layer 2 disabled; Layer 1 and the mechanical fallback still function (they need no LLM).
- **Sub-agents**: `runToolLoop` is bounded (8 steps) and out of scope; delegation already returns condensed results to the caller.

---

## Requirements *(mandatory)*

### Functional Requirements — Estimation & thresholds

- **FR-001**: Token estimation is a pure, isolated module (`estimateTokens(messages)`), initial heuristic `ceil(chars/4)` over serialized content — **no new dependencies**. The module MUST isolate the heuristic so a real tokenizer can replace it without interface change.
- **FR-002**: Effective budget = (`maxInputTokens` ?? `compaction.assumedContextTokens`) − output headroom. Defaults: `clearThreshold` 50% of budget, `summarizeThreshold` 75%, `hardLimit` 92%. All configurable via the `compaction` namespace (FR-018).
- **FR-003**: Below `clearThreshold` the middleware is a pass-through: zero LLM calls, zero writes, byte-identical output (SC-002).

### Functional Requirements — Layer 1: tool-result clearing

- **FR-004**: When estimated tokens ≥ `clearThreshold`, advance a persisted **clear-watermark**: all tool-result contents at positions older than the newest `keepToolResults` (default 5) tool-use/result pairs are replaced, in one batch, by a single-line placeholder: tool name + `"output elided to save context — re-run the tool if the output is needed again"`. Tool-call parts (assistant side) are preserved verbatim; message structure and ordering are unchanged.
- **FR-005**: Clearing is deterministic from the sidecar watermark: between watermark advances, repeated requests produce a byte-identical transformed prefix (prompt-cache preservation; SC-003). A rolling every-turn mask is explicitly non-compliant.
- **FR-006**: Tools listed in `compaction.unrecoverableTools` (default: empty) are never cleared. The default placeholder MUST make regeneration actionable (the cleared span is also eventually covered by the Layer-2 summary).

### Functional Requirements — Layer 2: summarization

- **FR-007**: When estimated tokens ≥ `summarizeThreshold` and no valid summary covers the overflow, the middleware schedules an **asynchronous** summarization (fire-and-forget with error logging) and serves the current turn without waiting. Compaction work MUST never block a user-facing model call, except the FR-011 hard-limit fallback.
- **FR-008**: Boundary selection: keep the most recent tail (default: max(last 20% of budget, last 10 messages)) verbatim; walk the cut back so (a) no tool group is split and (b) the kept tail begins at a user message. The summarized span is everything before the cut (including previously cleared placeholders and any previous summary — anchored update, see Edge Cases).
- **FR-009**: The summarizer runs via `complete()` (`src/lib/agent/llm.ts`) — provider-agnostic, honoring `compaction.model` as an optional cheaper override. Its system prompt is the bundled [`prompts/compaction-summary-system.md`](prompts/compaction-summary-system.md) — normative, embedded verbatim (FR-013). Input: the serialized span + previous summary if any. Output: the structured summary text.
- **FR-010**: The sidecar stores `{ boundary: { count, spanHash }, summary, clearWatermark, lock, updatedAt, stats }`. `spanHash` is a content hash of the summarized span; on any mismatch at apply time the state is discarded (US-5.2). Writes are atomic (temp-file + rename, as in `memory/curated.ts`); the summary text is injection-scanned before persisting.
- **FR-011**: **Hard-limit fallback**: if a request arrives with estimated tokens ≥ `hardLimit` and no applicable summary, the middleware synchronously applies a mechanical, pair-safe truncation — keep the first user message and the largest recent tail that fits — logs a warning, and still schedules Layer 2. A provider context-length 400 due to unmanaged growth is a spec violation.
- **FR-012**: Summary injection shape: one user-role message whose text is wrapped in `<conversation_summary>…</conversation_summary>`, ending with the fixed recovery note ("Earlier details from this conversation were compacted. Durable lessons may be retrievable via memory_search."), spliced immediately before the kept tail. Nothing else is inserted or reordered.
- **FR-013**: The bundled prompt is **normative**: the implementation MUST embed its body verbatim (leading HTML comment stripped) as a module constant; any wording change is a spec change made in the bundled file first (same rule as 021 FR-021).

### Functional Requirements — Memory-loop integration (soft dependency on 021)

- **FR-014**: If the 021 fast-loop module is present, the summarization job MUST first invoke the fast-loop review for this conversation (idle threshold waived, same code path as 021 FR-009) covering turns up to the boundary, and only then summarize. If absent or failing, proceed without it (log the skip) — compaction MUST NOT hard-depend on 021.
- **FR-015**: Automated compaction never writes `USER.md`, `MEMORY.md`, topics, episodes, or skills directly — durable extraction is exclusively the memory loops' job. Compaction owns only its sidecar.

### Functional Requirements — Placement & invariants

- **FR-016**: The middleware wraps the model in `/api/copilotkit/route.ts` at the existing `getLanguageModel()` call site, keyed by the pinned `conv` id; requests without a conversation id are pass-through. No CopilotKit internals are modified; the OpenAI normalization proxy is untouched.
- **FR-017**: The system prompt is never part of the transformable input — `composeInstructions()` output must reach the provider unmodified (constraint pinning; US-3.1).

### Functional Requirements — Configuration & observability

- **FR-018**: A `compaction` config namespace (registered in `src/lib/config/registry.ts`, hence settings-tab- and agent-visible) MUST expose: enabled (default on), assumedContextTokens, clearThreshold, summarizeThreshold, hardLimit (as fractions), keepToolResults, keepTailMessages, unrecoverableTools, model override, lock staleness.
- **FR-019**: Every compaction event (clear advance, summary scheduled/applied/refused, hash invalidation, fallback, lock expiry) is logged to the central logging facility with conversation id and token stats. `GET /api/compaction?conv=<id>` returns the sidecar view; `POST /api/compaction?conv=<id>` forces a summarization now (manual trigger, mirrors the curator's on-demand pattern).
- **FR-020**: Sidecar files for conversations deleted from `/Documents/Chats` are garbage-collected opportunistically (on read miss or a periodic sweep) — never block on it.

### Key Entities

- **Compaction sidecar** — `data/memory/compaction/<convId>.json`; the only state this feature owns; atomic, hash-validated, discardable at any time (worst case: recompute).
- **Clear-watermark** — persisted index up to which tool results are placeholdered; advances in batches; guarantees a stable transformed prefix between advances.
- **Summary boundary** — `(count, spanHash)` pair identifying exactly which client-sent messages the summary replaces.
- **Compacted view** — the transformed message array actually sent to the provider; a pure function of (client messages, sidecar).
- **Hard-limit fallback** — LLM-free pair-safe truncation; the safety net that makes provider overflow errors impossible.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Randomized-boundary tests (compaction forced at arbitrary points over recorded tool-heavy transcripts) produce zero provider 400s for orphaned tool pairs or message-order violations, on both provider families.
- **SC-002**: A conversation below `clearThreshold` incurs zero compaction LLM calls and zero sidecar writes; the middleware output is byte-identical to its input.
- **SC-003**: Between consecutive watermark/summary events, the transformed prefix is byte-identical across turns (asserted by test; proxy for prompt-cache hits).
- **SC-004**: With thresholds test-lowered to 10–25% of budget: a constraint probe ("never do X" stated pre-boundary) and a needle probe (fact stated pre-boundary) both survive forced summarization — the constraint is honored and the fact is either in the summary or retrieved via `memory_search` (with 021 installed).
- **SC-005**: A conversation grown past `hardLimit` with the summarizer disabled still completes turns via the fallback — no provider context-length error is ever surfaced to the user.
- **SC-006**: `/Documents/Chats/**` shows zero writes attributable to compaction across the full test suite; discarding the entire sidecar directory at any time yields a working (uncompacted or recomputed) conversation.

---

## Implementation Guidance *(informative — existing touchpoints)*

| Piece | Where | Notes |
|---|---|---|
| Middleware + wiring | new `src/lib/agent/compaction/middleware.ts`; edit `src/app/api/copilotkit/route.ts` (wrap at the `getLanguageModel()` site) | `wrapLanguageModel` + `transformParams` from `ai` v6; conv id already in scope |
| View transform | new `src/lib/agent/compaction/view.ts` | pure function (messages, sidecar) → messages; all pair-safety/boundary walking here — unit-test this hardest |
| Estimation | new `src/lib/agent/compaction/estimate.ts` | chars/4; FR-001 isolation |
| Sidecar store | new `src/lib/agent/compaction/sidecar.ts` | atomic-write + `looksLikeInjection` patterns from `memory/curated.ts`; lock with staleness like 021 FR-011 |
| Summarizer job | new `src/lib/agent/compaction/summarize.ts` | `complete()` from `llm.ts`; optional 021 fast-loop invocation (dynamic import / feature-detect, FR-014) |
| Config | `src/lib/config/registry.ts` namespace `compaction` | settings tab + agent visibility for free |
| API | new `src/app/api/compaction/route.ts` (GET state / POST force) | mirror curator on-demand pattern |
| Prompt | `prompts/compaction-summary-system.md` (bundled) | normative, FR-013 — embed verbatim as module constant |
| Docs/spec | update `docs/dev/assistant/overview.md`, cross-link `docs/dev/assistant/context-compaction-research.md`; register this spec via Build Studio | per working rules |

Constraints: no new npm dependencies; no `package.json`/lockfile changes; feature branch `bos/context-compaction`; `npx tsc --noEmit` + `npm run lint` clean; do not run `npm run build` while `next dev` is live.

Suggested implementation order (each step shippable): (1) estimation + view transform + Layer 1 with sidecar and route wiring; (2) hard-limit fallback + logging + config namespace; (3) Layer 2 async summarizer + normative prompt + API routes; (4) 021 fast-loop hook + probe-based test suite (SC-004).

## Bundled Artifacts

```
specs/022 - context-compaction/
├── 022-context-compaction-spec.md              this spec
└── prompts/
    └── compaction-summary-system.md            normative system prompt, summarizer (FR-013)
```

## Build Studio Workflow Status

- [x] **Spec**: Complete and aligned with 021-memory-loops
- [x] **Clarify**: No clarifications needed; spec is self-contained
- [x] **Plan**: `plan.md` created with phased implementation strategy
- [x] **Tasks**: `tasks.md` created with 21 actionable tasks across 4 phases

## Notes

- Companions: `021-memory-loops` (soft dependency, FR-014/015), `002-memory`, research basis `docs/dev/assistant/context-compaction-research.md`.
- Deliberate non-goals: provider server-side compaction (Anthropic `compact_20260112` / OpenAI `/responses/compact`) — BOS is multi-provider with local models first-class; MAY later become an Anthropic-only fast path behind the same sidecar interface. Token-level compression (LLMLingua) and embedding-based message retention: rejected (research doc §2.5). Compacting `runToolLoop` sub-agent loops: out of scope while bounded at 8 steps. A chat-UI compaction boundary marker: nice-to-have, not required by this spec (state is observable via `GET /api/compaction`).
- Evidence anchors for the defaults: clear-before-summarize ordering and placeholder semantics (observation masking ≈ summarization at half cost, arXiv:2508.21433); batch clearing for cache stability (Anthropic `clear_at_least` guidance); 75% pre-emptive trigger (production systems cluster 70–85%; context rot precedes overflow); structured summary sections incl. standing constraints (constraint decay, arXiv:2606.22528; Factory.ai anchored summarization).
