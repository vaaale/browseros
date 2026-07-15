# Implementation Plan: Context Compaction (Layered Conversation Compactification)

**Feature**: 022-context-compaction
**Spec Status**: Ready for Planning
**Target Branch**: `bos/bos-conversation-compaction` (spec names it `bos/context-compaction`; the worktree branch this is authored on is the one to use)

---

## Technical Context

This feature adds server-side context management to the CopilotKit request path. Today the middleware chain between the client (which owns the transcript) and the provider is a straight pass-through: `AnthropicAdapter` / `OpenAIChatAdapter` forward every message on every turn. Long or tool-heavy conversations therefore (a) suffer context rot, (b) grow costs quadratically, and (c) eventually hard-fail with a provider context-length 400.

The fix is a **pure view transformation on what is sent to the model** — the client-owned transcript at `/Documents/Chats/<id>.json` is NEVER rewritten. The transformation is layered:

1. **Layer 1 — Mechanical tool-result clearing** (no LLM call). Advances a persisted clear-watermark at the `clearThreshold`; older tool results become one-line placeholders.
2. **Layer 2 — Asynchronous structured summarization** past `summarizeThreshold`. Fire-and-forget; the current turn is served with the existing view; the summary applies from the first turn after it lands.
3. **Layer 3 — Hard-limit fallback** at `hardLimit`. Synchronous mechanical pair-safe truncation; the safety net that makes provider overflow errors impossible.

Compaction is a **companion to 021-memory-loops**: episodes are the write-before-compaction store, and `memory_search` is the post-compaction recovery path. 021 is a **soft dependency** — compaction works without it (log the skip and proceed), but with 021 installed the summarization job invokes the fast-loop review first, so durable lessons land in an episode before the model's view is compressed.

The single choke point that makes this feasible is `serviceAdapter.getLanguageModel()` in `src/app/api/copilotkit/route.ts`, which returns an AI SDK `LanguageModel` (`ai` v6) that can be wrapped with `wrapLanguageModel({ middleware: { transformParams } })`. That middleware sees every model call (including intra-turn tool-loop steps) for both provider families.

### Existing Touchpoints

| Component | Path | Role in This Feature |
|-----------|------|---------------------|
| CopilotKit route | `src/app/api/copilotkit/route.ts` | Wrap the model returned from `serviceAdapter.getLanguageModel()` with the compaction middleware, keyed by the `?conv=<id>` param already in scope (line 65). |
| Provider LLM entrypoint | `src/lib/agent/llm.ts` | `complete()` runs the summarizer; honors optional `compaction.model` override. |
| Memory store patterns | `src/lib/agent/memory/curated.ts` | Reference for atomic writes (temp-file + rename) and injection scanning (`looksLikeInjection`) — sidecar reuses these patterns. |
| Injection detector | `src/lib/agent/memory/injection.ts` | Summarizer output MUST pass `looksLikeInjection` before entering the sidecar. |
| 021 fast loop | `src/lib/agent/memory/fast-loop.ts` | `runFastLoop({ ... })` called via dynamic import + feature-detect (FR-014). |
| Config registry | `src/lib/config/registry.ts` | New `compaction` namespace (settings-tab-visible, agent-visible). |
| Central logging | `src/lib/logging/server-logger.ts` | Every compaction event logged with `component: 'compaction'`, conv id, token stats. |
| System instructions | `src/lib/agent/instructions.ts` (`composeInstructions()`) | Untouched — never in the transformable input; constraint pinning invariant (FR-017). |

### New Modules to Create

```
src/lib/agent/compaction/
├── estimate.ts           # Pure token estimator; chars/4 heuristic isolated (FR-001)
├── view.ts               # Pure (messages, sidecar) → transformed messages
│                         # boundary walking, pair-safety, splice
├── sidecar.ts            # Atomic read/write of data/memory/compaction/<convId>.json
│                         # lock w/ staleness, spanHash validation, injection scan
├── summarize.ts          # Async summarization job: 021 fast-loop hook + complete()
│                         # + normative prompt embedded as constant (FR-013)
├── middleware.ts         # wrapLanguageModel wrapper: transformParams hook
│                         # dispatches Layer 1 / Layer 2 scheduling / hard-limit fallback
└── config.ts             # Compaction config namespace read helpers

prompts/
└── compaction-summary-system.md      # NORMATIVE, already authored in
                                      # specs/bos-system-specs/022-context-compaction/prompts/
                                      # copy into repo root prompts/ during Phase 3

src/app/api/compaction/
└── route.ts              # GET (sidecar view) / POST (force summarization now)

data/memory/compaction/              # runtime sidecar directory (gitignored under ./data)
└── <convId>.json                    # per-conversation sidecar
```

---

## Constitution Check

Against `.specify/memory/constitution.md`:

| Principle | Compliance |
|-----------|------------|
| **Specs before code** | ✅ This plan derives from the approved spec; implementation delegates to Developer sub-agent. |
| **No npm dependencies** | ✅ `wrapLanguageModel` / `transformParams` already ship with `ai` v6; token estimator uses chars/4; no vector or tokenizer libs. |
| **Atomic writes** | ✅ Sidecar uses temp-file + rename, reusing the pattern from `memory/curated.ts`. |
| **Injection safety** | ✅ Summarizer output scanned with existing `looksLikeInjection` before persisting — text re-enters prompts. |
| **Client owns the transcript** | ✅ `/Documents/Chats/<id>.json` is never written; compaction owns only the sidecar. |
| **Constraint pinning** | ✅ The system prompt (CORE_POLICY + personality + memory + skills/MCP indices) reaches the provider unmodified — the middleware only transforms the `messages` array. |
| **Companion feature, not lock-in** | ✅ 021 fast-loop hook is a feature-detected dynamic import; absence is a logged skip, not a failure. |

---

## Project Structure (Real Paths)

### Phase 1: Estimation + View Transform + Layer 1 + Route Wiring

```
src/lib/agent/compaction/estimate.ts       # NEW — pure chars/4 estimator (FR-001)
src/lib/agent/compaction/view.ts           # NEW — pure view transform (FR-004..006, FR-008 tail rules)
src/lib/agent/compaction/sidecar.ts        # NEW — atomic sidecar + spanHash + lock skeleton
src/lib/agent/compaction/middleware.ts     # NEW — Layer 1 only in this phase (schedule Layer 2 is a no-op)
src/app/api/copilotkit/route.ts            # MODIFY — wrap model with withCompaction(model, convId)
data/memory/compaction/                    # created on first sidecar write
```

**Deliverable**: Below-threshold conversations are byte-identical pass-through (SC-002). Tool-heavy conversations that cross `clearThreshold` see older tool-results collapsed to one-line placeholders in stable, watermarked batches (SC-003). Tool-call parts and message ordering are preserved. Requests without a `conv` id pass through unmodified.

### Phase 2: Hard-Limit Fallback + Logging + Config Namespace

```
src/lib/agent/compaction/middleware.ts     # EXTEND — add hard-limit fallback (Layer 3)
src/lib/agent/compaction/config.ts         # NEW — typed getters for compaction namespace
src/lib/config/registry.ts                 # MODIFY — register `compaction` namespace (FR-018)
src/lib/logging/server-logger.ts           # USE — every clear-advance, fallback, lock event
```

**Deliverable**: A conversation grown past `hardLimit` completes turns via a mechanical, pair-safe truncation with a WARN log (SC-005). All Phase-1 events plus the fallback are visible in the central log with `component: 'compaction'`, `conv`, and token stats. Config namespace visible in the Settings UI and to the agent.

### Phase 3: Layer 2 Async Summarizer + Normative Prompt + API Routes

```
src/lib/agent/compaction/summarize.ts      # NEW — async job: 021 hook (feature-detect), complete(),
                                           #        anchored update, spanHash+lock, injection scan
prompts/compaction-summary-system.md       # NEW — copy verbatim from the spec bundle;
                                           #        embed as SUMMARY_SYSTEM_PROMPT constant
src/lib/agent/compaction/middleware.ts     # EXTEND — schedule Layer 2 at summarizeThreshold;
                                           #        apply summary when sidecar has valid one
src/lib/agent/compaction/view.ts           # EXTEND — splice [summary user-message] + [kept tail]
                                           #        (FR-012 shape) when sidecar carries a summary
src/app/api/compaction/route.ts            # NEW — GET state / POST force
```

**Deliverable**: Long conversations get an asynchronous, structured summary; the model receives `[system prompt] [summary message] [kept recent tail]` from the first turn after the summary lands. `GET /api/compaction?conv=<id>` returns the sidecar view; `POST /api/compaction?conv=<id>` forces a summarization run. Locking prevents overlap; stale locks expire after 10 min.

### Phase 4: 021 Fast-Loop Hook + Probe Tests + Documentation

```
src/lib/agent/compaction/summarize.ts      # WIRE — invoke 021 runFastLoop via dynamic import
                                           #        (feature-detect; absent → logged skip)
tests/compaction/estimate.test.ts          # NEW — pure heuristic
tests/compaction/view.test.ts              # NEW — pair-safety, boundary rules, byte-identity
tests/compaction/sidecar.test.ts           # NEW — atomic writes, spanHash mismatch discard
tests/compaction/probes.test.ts            # NEW — SC-004: constraint & needle probes
tests/compaction/hard-limit.test.ts        # NEW — SC-005: fallback with summarizer disabled
tests/compaction/no-transcript-writes.test.ts  # NEW — SC-006: zero /Documents/Chats writes
docs/dev/assistant/overview.md             # UPDATE — link the research doc + explain the layer stack
docs/dev/assistant/context-compaction-research.md  # KEEP — cross-linked from overview
specs/bos-system-specs/discrepancies.md    # UPDATE — note 022 vs 021 relationship (soft dep)
```

**Deliverable**: With 021 installed, the summarization job runs the fast-loop review first (idle threshold waived) covering turns up to the boundary before the model's view is compressed (FR-014, US-4.1). Probe suite exercises SC-004 by forcing summarization with thresholds test-lowered to 10–25% and asserting standing-constraint preservation and needle recovery. Success criteria SC-001..SC-006 all validated.

---

## Design Notes

### The one wiring point (FR-016)
Compaction is wired **exactly once**, at the `getLanguageModel()` call site in `src/app/api/copilotkit/route.ts` (currently line 65):

```ts
const rawModel = agentId ? serviceAdapter.getLanguageModel?.() : undefined;
const model = rawModel && convId ? withCompaction(rawModel, convId) : rawModel;
```

Requests without a `conv` id (agent-less discovery / runtime-info pings) pass through unwrapped. No CopilotKit internals are modified; the OpenAI normalization proxy is untouched. This placement guarantees the middleware sees intra-turn tool-loop steps for both provider families.

### Pure view transform (FR-004..012)
`src/lib/agent/compaction/view.ts` is a pure function `(messages, sidecar) => messages`. Testing it in isolation covers the hardest correctness surface:
- Tool-pair integrity: every boundary (clear-watermark, summary boundary, fallback cut) walks back so a tool-call and its matching result(s) stay together.
- Tail start rule: the kept tail MUST begin at a user message. Walk the cut back one more step if it lands on assistant/tool.
- Splice shape (FR-012): one user-role message wrapping the summary in `<conversation_summary>…</conversation_summary>` and ending with the fixed recovery note, spliced immediately before the kept tail. Nothing else is inserted or reordered.
- Byte-identity (SC-002, SC-003): below `clearThreshold` output equals input byte-for-byte; between watermark/summary events the transformed prefix is byte-identical across turns (proxy for prompt-cache hits — the LLM-provider adapter is deterministic on identical input).

### Sidecar shape (FR-010)
```
data/memory/compaction/<convId>.json
{
  "boundary": { "count": <int>, "spanHash": "<sha256 of summarized span>" },
  "summary": "<summary text; injection-scanned>",
  "clearWatermark": <int>,           // index up to which tool-results are placeholdered
  "lock": { "acquiredAt": "<iso>", "owner": "<pid-or-uuid>" } | null,
  "updatedAt": "<iso>",
  "stats": { "estimatedTokens": <int>, "compactedAt": "<iso>", "runs": <int> }
}
```
Atomic writes via temp-file + rename (same pattern as `memory/curated.ts`). Summary text passes `looksLikeInjection` before persistence; refused output is dropped and logged. Any hash mismatch at apply time → discard state and recompute (US-5.2).

### Anchored summarization (FR-008, Edge Cases)
A re-summarization's input is `previousSummary + newlyEvictedSpan`, producing ONE updated summary. Summaries of summaries of summaries are forbidden (drift amplification). The bundled prompt handles the merge explicitly ("If a previous summary is provided, produce ONE updated summary: merge the new span into it…").

### Locking (Edge Cases)
One summarization in flight per conversation. The sidecar's `lock` field holds `{ acquiredAt, owner }`; staleness expiry (default 10 min, configurable via `compaction.lockStalenessMs`) means a crashed job cannot wedge the conversation. The middleware never waits on the lock; concurrent turns during summarization see the pre-summary view until the summary lands.

### 021 soft dependency (FR-014, US-4.3)
```ts
// summarize.ts, before invoking complete()
let fastLoop: typeof import("../memory/fast-loop") | null = null;
try { fastLoop = await import("../memory/fast-loop"); } catch { /* absent — skip */ }
if (fastLoop?.runFastLoop) {
  try {
    await fastLoop.runFastLoop({ conversationId, waiveIdleThreshold: true, upToMessageIndex: boundary.count });
  } catch (err) {
    log.warn({ component: "compaction", conv: convId, err }, "fast-loop review failed — proceeding without it");
  }
}
```
If 021 is not present, or `runFastLoop` throws, the summarization proceeds. Compaction is never blocked by 021's status.

### Config namespace (FR-018)
Register in `src/lib/config/registry.ts` under `compaction`:
```
compaction.enabled                 (bool, default true)
compaction.assumedContextTokens    (int,  default 128000)
compaction.clearThreshold          (frac, default 0.50)
compaction.summarizeThreshold      (frac, default 0.75)
compaction.hardLimit               (frac, default 0.92)
compaction.keepToolResults         (int,  default 5)     // FR-004
compaction.keepTailMessages        (int,  default 10)    // FR-008 minimum tail
compaction.tailBudgetFraction      (frac, default 0.20)  // FR-008: max(this, keepTailMessages)
compaction.unrecoverableTools      (str[], default [])   // FR-006
compaction.model                   (str,  optional)      // FR-009 override
compaction.lockStalenessMs         (int,  default 600000)
```
Fractions are floats in `[0, 1]`; validate `clearThreshold < summarizeThreshold < hardLimit`.

### Prompt embedding (FR-013)
The bundled `prompts/compaction-summary-system.md` is normative. Copy it verbatim into the repo-root `prompts/` directory during Phase 3, then embed in `summarize.ts` as `export const SUMMARY_SYSTEM_PROMPT = /* verbatim body, HTML comment stripped */`. Any wording change is a spec change made in the bundled file first (same rule as 021 FR-021).

### Observability (FR-019)
Every event is logged via the central server logger with `component: 'compaction'`, `conv: <id>`, and token stats:
- `clear.advance` — watermark advanced
- `summary.scheduled` / `summary.applied` / `summary.refused` (injection scan failed)
- `hash.invalidated` — client edited history; state discarded
- `fallback.applied` — hard-limit fallback triggered
- `lock.expired` — stale lock reclaimed
- `fast-loop.skipped` / `fast-loop.failed` — 021 hook outcome

`GET /api/compaction?conv=<id>` returns the sidecar as JSON; `POST /api/compaction?conv=<id>` forces a summarization run now (mirrors curator on-demand pattern).

### Garbage collection (FR-020)
On a sidecar-read miss for a conversation id that has no corresponding `/Documents/Chats/<id>.json`, the sidecar is deleted opportunistically. A periodic sweep (once per hour on the same tick used by any existing memory sweeper, or lazily on read) removes orphaned sidecars — never block on it.

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| **Middleware breaks non-compaction paths** (agent-less pings, discovery) | Guard: only wrap when both `agentId` and `convId` are present. Pass-through path is unchanged. |
| **Provider hard-400 on orphaned tool pairs** | All boundary walkers treat `(tool_call, tool_result)` as one atomic group. Randomized-boundary tests (SC-001) force cuts at arbitrary points over recorded tool-heavy transcripts. |
| **AI SDK merges consecutive same-role messages** (summary + kept-tail-first-user) | Explicit assertion in the view test that the summary is a user role AND the first kept-tail message is a user role — merging is expected and safe as long as the shape is preserved. |
| **Summarizer output attacks the assistant** | Text passes `looksLikeInjection` before persisting; refused output is dropped and logged. Content is wrapped in `<conversation_summary>` tags so downstream prompts can spot spillover. |
| **Client edits history mid-conversation** | `spanHash` on the boundary catches drift; on mismatch, sidecar state is discarded and recomputed on the next turn. |
| **Crashed summarizer wedges the conversation** | Lock has staleness expiry (default 10 min); next turn reclaims it and logs `lock.expired`. |
| **Summarizer failure loops** | Retry at most once per lock acquisition; on repeat failure log and leave state unchanged. Hard-limit fallback still protects the conversation. |
| **`maxInputTokens` unset for a provider** | Fall back to `compaction.assumedContextTokens` (default 128000). Reserve output headroom (`maxTokens ?? DEFAULT_MAX_TOKENS`) when computing the effective budget. |
| **Prompt-cache invalidation from rolling masks** | Layer 1 uses a persisted watermark that advances in batches; between advances the transformed prefix is byte-identical (SC-003 test). Rolling every-turn masking is explicitly non-compliant. |
| **`hasCredentials()` false** | Layer 2 disabled entirely; Layer 1 and the hard-limit fallback still function (neither needs an LLM). |

---

## Testing Strategy

### Unit tests (pure functions — cheap, exhaustive)
- `estimate.test.ts` — chars/4 heuristic, edge cases (empty messages, unicode, tool parts).
- `view.test.ts` — pair-safety at every boundary, tail-starts-at-user rule, byte-identity below threshold, splice shape (FR-012), unrecoverable-tools carve-out.
- `sidecar.test.ts` — atomic write, spanHash validation, hash-mismatch discard, lock acquisition + staleness expiry, injection-scan refusal.

### Integration tests (via the wrapped model)
- `hard-limit.test.ts` — SC-005: summarizer disabled, conversation past `hardLimit`, verify fallback truncation is pair-safe and returns non-empty output; assert a WARN log entry.
- `no-transcript-writes.test.ts` — SC-006: run the full compaction lifecycle in a temp workspace, assert zero writes to `/Documents/Chats/**`; delete the compaction sidecar directory mid-test and verify the next turn still completes.
- `randomized-boundary.test.ts` — SC-001: replay a recorded tool-heavy transcript, force compaction at randomized indices, assert zero orphaned tool pairs across both provider families.

### Probe tests (SC-004; require thresholds test-lowered to 10–25%)
- `probes.test.ts` — constraint probe: user says "never do X" pre-boundary; force summarization; run a turn that would violate the constraint; assert the response honors it (standing constraint survived summarization).
- `probes.test.ts` — needle probe: user states a specific fact pre-boundary; force summarization; ask a question requiring that fact; assert the fact is either in the summary text OR retrieved via `memory_search` (with 021 installed).

### Cache-preservation assertion (SC-003)
Between consecutive turns with no threshold crossing, the transformed prefix is byte-identical. Test by hashing the messages array minus the last message across two turns and asserting equality.

### Acceptance scenario validation
All User Stories 1–5 exercised via the integration + probe tests above.

---

## Dependencies & Ordering

| Step | Depends On | Blocks |
|------|------------|--------|
| Phase 1 (estimate + view + Layer 1 + wiring) | Existing `ai` v6 API only | Phase 2, Phase 3 |
| Phase 2 (hard-limit fallback + logging + config) | Phase 1 | — (shippable MVP: no LLM cost, no crashes on overflow) |
| Phase 3 (Layer 2 + prompt + API routes) | Phase 1, Phase 2 (uses config namespace + logging) | Phase 4 |
| Phase 4 (021 hook + probe tests + docs) | Phase 3 (needs the summarize job to hook into) | Feature complete |

**MVP shippable after Phase 2**: no LLM cost, hard-limit fallback prevents provider 400s. Phase 3 turns on quality-preserving summarization. Phase 4 closes the loop with 021 and locks the acceptance surface.

---

## Open Questions

1. **`hasCredentials()` scope**: Confirm the intended check is at the compaction-config level (per-conversation provider) rather than a global flag. Default: check the same credentials path the CopilotKit route uses for `getLanguageModel()`.
2. **Fallback truncation size**: Spec says "keep the first user message and the largest recent tail that fits". Confirm the target size — proposed default: fit inside `summarizeThreshold` (not `hardLimit`) so the next turn also has room. Configurable via `compaction.fallbackTargetFraction`? (Optional; can inherit from `summarizeThreshold` by default.)
3. **Sidecar sweep cadence**: Opportunistic on read miss is guaranteed; do we also want a scheduler-registered periodic sweep, or is on-demand enough for MVP? Default: on-demand only for now; add a sweep job later if orphan accumulation becomes visible.

These are answered in a `/clarify` pass if needed; defaults above apply otherwise.
