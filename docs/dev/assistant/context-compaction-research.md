# Conversation Compaction — State of the Art (research, July 2026)

Research groundwork for a BOS conversation-compactification feature. Covers what production agent systems ship, what the research evidence supports, known failure modes, and a recommended approach for BOS. No implementation decisions are made here; see "Recommendations for BOS" for the proposed direction.

---

## 1. Key takeaways

1. **The field converged on a layered approach, not a single technique.** Order of ROI: (a) mechanical tool-result clearing/masking, (b) threshold-triggered structured summarization, (c) persistent memory/notes outside the context window. Token-level compression (LLMLingua) and KV-cache methods are irrelevant for API-consumer platforms like BOS.
2. **The cheap dumb thing ties the expensive smart thing.** JetBrains' controlled study ([The Complexity Trap](https://arxiv.org/abs/2508.21433), NeurIPS 2025 DL4Code) found that simply **masking old tool observations with a placeholder halves cost while matching or beating LLM summarization's solve rate** on SWE-bench Verified across 5 model configs. Do this first.
3. **Compaction is lossy in specifically dangerous ways.** The best-quantified failure: in-context "don't do X" constraints go from **0% violation to ~30% (up to 59%) after a single compaction**, compounding to 78% over 4 rounds ([Governance Decay, arXiv:2606.22528](https://arxiv.org/html/2606.22528v1) — single preprint, but reproduced across LangGraph/LangMem/AutoGen). File/artifact tracking is the weakest retention dimension in every tested system ([Factory.ai eval](https://factory.ai/news/evaluating-compression): ≤2.45/5).
4. **Structured summaries beat freeform.** Every serious system uses a sectioned checklist prompt (intent, decisions, files touched, errors, next steps), not "summarize this conversation." Factory's anchored/structured approach scored 3.70 vs Anthropic's built-in 3.44 vs OpenAI's 3.35 on probe-based retention (vendor-run eval; methodology published).
5. **Compacting early beats compacting at the limit.** Models degrade well before the window fills ("context rot": all 18 tested frontier models degrade with input length even on trivial tasks — [Chroma research](https://research.trychroma.com/context-rot); [NoLiMa](https://arxiv.org/abs/2502.05167) shows most models' effective length is far below their advertised window). Production thresholds cluster at 70–85% of the window.
6. **Providers now ship compaction server-side.** Anthropic: `compact_20260112` context-management edit (beta, Opus/Sonnet 4.6 — readable summary block). OpenAI: Responses API compaction (opaque encrypted blob). Both remove client-side complexity but reduce control; Anthropic's is the more transparent of the two.
7. **A counter-movement avoids summarization entirely**: file-offloading of tool outputs with re-read-on-demand (Claude Code microcompact, Cursor "dynamic context discovery", opencode pruning) and fresh-thread handoff (Amp removed compaction outright in Oct 2025).

---

## 2. Taxonomy of methods

### 2.1 Mechanical clearing / masking (no model call)

Replace old tool *results* with a short placeholder ("output elided — re-run tool or read file to recover"), keeping the tool-call record so message structure stays valid. Variants:

- **Server-side**: Anthropic [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) (`clear_tool_uses_20250919`): default trigger 100K input tokens, keeps last 3 tool-use/result pairs, `exclude_tools` to pin unrecoverable outputs. Anthropic reports +29% on a 100-turn agentic eval from clearing alone (+39% with memory tool) — internal, unreplicated.
- **Client-side masking**: SWE-agent elides all but the last ~5 observations; opencode protects the last 40K tokens of tool output and prunes older ones logically (hidden, not deleted); Claude Code "microcompact" spills results >50K chars to disk keeping a ~2KB preview + path.
- **Rule**: only mask outputs the agent can regenerate (file reads, searches). Never mask one-shot data (user uploads, nondeterministic API responses).

Evidence: strongest cost/quality ratio of any technique ([arXiv:2508.21433](https://arxiv.org/abs/2508.21433); [OpenHands condensers](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents) report up to 2x cost cut, no measured degradation).

### 2.2 Summarization-based compaction

An LLM call replaces the older prefix with a summary; recent tail preserved verbatim.

- **Structured prompt** (converged field list across Anthropic, Claude Code, Deep Agents, Factory, Gemini CLI, opencode): user intent + success criteria; completed work / current state; files created/modified with exact paths; key decisions + rationale; errors and fixes; learnings/constraints; pending tasks / next steps; verbatim load-bearing snippets. LangChain measured that adding dedicated *session intent* and *next steps* fields improved post-compaction task performance.
- **Anchored/incremental** (Factory.ai): keep a persistent structured summary; on each trigger, summarize only the newly evicted span and merge into the anchor. Reduces telephone-game drift vs re-summarizing summaries. Trade-off: stale anchor sections are never revised.
- **Recursive/rolling** ([arXiv:2308.15022](https://arxiv.org/abs/2308.15022)): the academic formalization; LangMem's `RunningSummary` and LangChain v1 `summarizationMiddleware` (TypeScript: `trigger: {tokens, messages}`, `keep: {messages}`, cheap summarizer model allowed) are the mainstream implementations.
- **Server-side**: Anthropic [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) (`compact_20260112`, default trigger 150K input tokens, min 50K; `pause_after_compaction` lets you splice recent messages back verbatim; `instructions` *replaces* the default prompt — footgun; same-model summarization only; known issue: with tools defined the summarizer sometimes calls a tool → `content: null`). OpenAI: `/responses/compact` + in-stream compaction items (opaque, encrypted, preserves reasoning/tool state server-side).

### 2.3 Persistent memory / structured note-taking

The agent writes durable state to files/stores outside the window and re-reads on demand.

- **File-based** (Anthropic's bet): [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) (client-side CRUD under `/memories`), Claude Code CLAUDE.md + Auto Memory, plan/todo files re-read post-compact. Manus's rule: make compression *restorable* — drop content, keep the URL/path ([Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Extraction-based**: Mem0 (LLM extracts facts, ADD/UPDATE/DELETE consolidation; TS SDK `mem0ai`), Zep/Graphiti (temporal knowledge graph; Zep Cloud has a TS SDK, Graphiti core is Python), Letta (pivoted Feb 2026 from database memory tools to **git-backed context files** + background "memory reflection"). Caveat: all vendor cross-benchmarks (LoCoMo etc.) are contested marketing — in Mem0's own paper the full-context baseline beat Mem0 on accuracy; treat as unproven for accuracy, proven for cost/latency.
- **Key pattern — write-before-compaction**: extract/persist durables continuously (or on a pre-compaction hook), so the summarizer can be lossy without losing constraints. MemGPT's 2023 "memory pressure warning" was the primitive; Claude Code's PreCompact hook is the modern extensibility point.

### 2.4 Architectural avoidance

- **Sub-agent delegation**: workers with fresh windows return 1–2K-token distillates to an orchestrator ([Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)). Counterpoint: [Cognition](https://cognition.com/blog/dont-build-multi-agents) argues subagents lose shared context; Devin instead fine-tuned a dedicated compressor model.
- **Handoff instead of compaction** (Amp, Oct 2025): `/handoff <goal>` extracts relevant context into an editable prompt for a *new* thread. Rationale: compaction "encourages long, meandering threads… stacking summary on top of summary."
- **Todo recitation**: constantly rewrite a todo list into the context tail so goals stay in the high-attention zone (Manus).

### 2.5 Not applicable to BOS

- **Token-level pruning** (LLMLingua/-2): needs a self-hosted model, Python-only, produces cache-hostile stochastic output. Only pays for large static one-shot contexts.
- **KV-cache compression** (H2O, SnapKV, StreamingLLM): inference-server-side; unavailable to API consumers.

---

## 3. What production systems ship (mid-2026)

| System | Approach | Trigger | Notes |
|---|---|---|---|
| Claude Code | 3-tier: microcompact (tool-result offload to disk) → full LLM compact → session-memory compact | ~83.5% of window (version-dependent) | Post-compact rehydration: re-reads ~5 recent files, restores todos; `/compact [focus]`; PreCompact hook |
| Claude API | Server-side summary block (`compact_20260112`) + tool-result clearing (`clear_tool_uses_20250919`) | 150K / 100K input tokens (configurable) | Readable summary; ZDR-eligible; Anthropic's recommended path |
| OpenAI Responses | Server-side opaque compaction item; standalone `/responses/compact` | `compact_threshold` | Encrypted blob, not inspectable |
| Codex CLI | Summarize (hosted models: encrypted endpoint) | model default ~180–244K, capped at 90% | Warns users accuracy drops after multiple compactions |
| Gemini CLI | Structured XML state snapshot; last ~30% preserved verbatim | 70% of window (default) | Open source; good reference prompt |
| Cursor | Auto-summarize + `/summarize`; 2026 direction: avoid summarization via file-offloading ("dynamic context discovery") | near limit | Docs admit post-summary forgetting |
| opencode | Two-phase: prune tool outputs (protect last 40K) → structured Markdown summary | overflow or `/compact` | Logical pruning (hidden, not deleted); pluggable prompt |
| Amp | **No compaction** — Handoff to fresh thread | manual | Deliberate rejection of compaction |
| LangChain v1 (TS) | `summarizationMiddleware` with tool-pair-safe cutoff | token/message thresholds, fractional window | Closest off-the-shelf TS reference implementation |

---

## 4. Hard invariants and failure modes

### Invariants (will 400 if violated)

- OpenAI: assistant `tool_calls` must be followed by `tool` messages answering every `tool_call_id`. Anthropic: every `tool_use` needs a matching `tool_result` in the next user message. Naive truncation between call and result is a documented production failure (Pipecat, OpenClaw). **Compaction boundaries must treat call+result as an atomic group** (Microsoft Agent Framework "MessageGroups"; LangChain `findSafeCutoffPoint`).
- Preserved segment should not *start* with an assistant message (breaks Gemini ordering rules).

### Failure modes (all documented in the wild)

- **Instruction/constraint loss** — system-adjacent instructions and negative constraints dropped from summaries. Claude Code's most-reported bug class (CLAUDE.md ignored post-compact, issues #4017/#19471/#24460). Quantified by Governance Decay: soft org policies decay ~8× more than hard safety norms. **Mitigation: constraint pinning** — keep instructions outside the compactable region and re-inject verbatim after every compaction (restores 0% violation at <0.5% token overhead).
- **Summary poisoning / drift** — an error in the summary becomes ground truth for all later turns; compounds across compactions ([Slipstream](https://arxiv.org/abs/2605.08580): 88–100% of resulting errors surface within 3 steps post-compaction). Adversarial variant: injected instructions crafted to survive compaction.
- **Lost work-state** — agent re-reads files, redoes or conflicts with its own earlier edits. Artifact/file tracking is the weakest dimension of every summarizer (Factory: ≤2.45/5). Mitigation: track touched files as structured state outside the transcript, not just in summary prose.
- **Goal drift** — agent asks for clarification or falsely declares completion right after compaction (the tell-tale eval signal). Why "session intent" and "next steps" are mandatory summary fields.
- **Infinite compaction loops / premature triggers** — threshold miscomputation and no-retry-limit bugs (multiple Claude Code issues). Compaction needs a retry cap and a hard fallback (mechanical truncation).
- **Prompt-cache invalidation** — any rewrite of history invalidates provider prompt caches from the edit point; frequent small edits are strictly worse than rare large ones. Compact rarely, in large chunks, keep the prefix (system prompt + pinned instructions + summary anchor) stable.

---

## 5. Trade-off summary

| Technique | Cost | Quality risk | Reversibility |
|---|---|---|---|
| Tool-result masking | ~zero (no model call) | Low if outputs are re-derivable | High (re-run tool / logical hiding) |
| Structured summarization | One near-window-size LLM call per event + cache invalidation | Constraint loss, poisoning, artifact-trail loss | None unless full transcript is persisted separately |
| Provider server-side compaction | Billed as extra iteration; zero client code | Less control over prompt (Anthropic: replace-only; OpenAI: opaque) | None (client can keep its own history) |
| Memory extraction (Mem0/Zep/Letta) | Continuous background LLM calls + infra | Staleness, unproven accuracy vs full context | High (queryable store) |
| Sub-agents / handoff | Higher total tokens (Anthropic: ~15× for multi-agent) | Lost shared context between agents | N/A |

Latency note: synchronous compaction inflates end-to-end latency 26–44%; async/idle-time compaction with validation recovers most of it (Slipstream, +up to 8.8pp SWE-bench Verified vs synchronous).

---

## 6. Recommendations for BOS

BOS constraints: TypeScript/Next.js, CopilotKit runtime (client-visible message history, tools registered via `*Actions.tsx`), multi-provider potential, runtime state persisted as files under `./data`. That last point is an asset — BOS already has the substrate for the file-based memory patterns above.

Proposed layering (each layer independently shippable; ship in this order):

1. **Tool-result clearing first** (highest ROI, no LLM call). In the CopilotKit message pipeline, before each model call: replace tool results older than the last N pairs (start N=3–5) with a placeholder naming the tool + a hint how to regenerate; keep tool-call records intact (atomic pairs). Pin/exclude unrecoverable outputs. Optionally spill large results to a file under `./data` with path + preview, Claude-Code-microcompact style.
2. **Threshold-triggered structured summarization** at ~75–80% of the effective window (not 95%). Anchored structured summary with mandatory sections: session intent, completed work, files touched (paths), decisions + rationale, errors + fixes, constraints, next steps. Keep the recent tail (e.g., last 20 messages or last 25% of budget) verbatim; walk the boundary so tool pairs never split.
3. **Constraint pinning**: CORE_POLICY, active-agent instructions, and user-stated constraints are never inside the compactable region; re-inject verbatim after every compaction. This addresses the single best-quantified failure mode.
4. **Write-before-compaction hook**: before summarizing, give the agent (or a cheap background call) a chance to persist durables to a notes file under `./data` — BOS's existing memory system is the natural target. Post-compact, re-read the notes + todo state (Claude Code's rehydration pattern).
5. **Keep the full transcript on disk** as the canonical record (compaction only changes what's *sent to the model*, never what's stored) so summarized-away facts are recoverable via search — this also gives free undo and debuggability.
6. **Safety rails**: retry cap on the summarizer, mechanical keep-first+keep-last truncation as hard fallback, and a visible compaction boundary marker in the UI.

If/when BOS runs primarily on Claude models via the Anthropic API, evaluate replacing layer 2 with server-side `compact_20260112` (+ `pause_after_compaction` to splice the recent tail) — it removes client complexity, but custom `instructions` fully replace the default prompt and must include "do not call tools; respond with text only."

Defer: memory-extraction vendors (Mem0/Zep/Letta) — accuracy benefits over full-context/notes-based approaches are unproven and the benchmark wars are unresolved; BOS's file-based memory covers the same need. Skip entirely: LLMLingua, KV-cache methods, embedding-based per-message retention (cache-hostile).

**Suggested success criteria for the eventual feature** (from the eval literature): (a) needle-retention probes — plant a fact early, force compaction, require recall; (b) constraint probes — a "never do X" rule must survive N compactions with 0 violations; (c) artifact-trail probes — agent must correctly list files it touched pre-compaction; (d) no API 400s from orphaned tool pairs under randomized compaction points; (e) goal-drift check — no spurious clarification requests or false completion claims immediately post-compaction. Stress-test by triggering compaction at 10–25% of the window.

---

## 7. Sources

Primary vendor docs: [Anthropic compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) · [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) · [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) · [Effective context engineering (Anthropic)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction) · [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [LangChain summarizationMiddleware (TS)](https://reference.langchain.com/javascript/functions/langchain.index.summarizationMiddleware.html) · [Microsoft Agent Framework compaction](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction)

Research: [The Complexity Trap (observation masking)](https://arxiv.org/abs/2508.21433) · [Governance Decay / ConstraintRot](https://arxiv.org/html/2606.22528v1) · [Slipstream (async compaction + validation)](https://arxiv.org/abs/2605.08580) · [ACON](https://arxiv.org/abs/2510.00615) · [Recursive summarization](https://arxiv.org/abs/2308.15022) · [MemGPT](https://arxiv.org/abs/2310.08560) · [Zep](https://arxiv.org/abs/2501.13956) · [Mem0](https://arxiv.org/abs/2504.19413) · [LongMemEval](https://arxiv.org/abs/2410.10813) · [Context Rot (Chroma)](https://research.trychroma.com/context-rot) · [NoLiMa](https://arxiv.org/abs/2502.05167) · [CoALA memory taxonomy](https://arxiv.org/abs/2309.02427)

Practitioner/engineering: [Factory.ai compression eval](https://factory.ai/news/evaluating-compression) · [Factory.ai compressing context](https://factory.ai/news/compressing-context) · [Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) · [Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) · [Amp Handoff](https://ampcode.com/news/handoff) · [Cursor dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery) · [Claude Code compaction deep dive](https://decodeclaude.com/compaction-deep-dive/) · [OpenHands condensers](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents) · [How Contexts Fail (Breunig)](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) · [OpenRouter message transforms](https://openrouter.ai/docs/guides/features/message-transforms) · [LangChain deepagents context management](https://www.langchain.com/blog/context-management-for-deepagents)

Failure-mode evidence: Claude Code GitHub issues [#4017](https://github.com/anthropics/claude-code/issues/4017), [#24460](https://github.com/anthropics/claude-code/issues/24460), [#7533](https://github.com/anthropics/claude-code/issues/7533), [#22758](https://github.com/anthropics/claude-code/issues/22758) · [Pipecat #3832](https://github.com/pipecat-ai/pipecat/issues/3832) · [langchainjs #9272](https://github.com/langchain-ai/langchainjs/issues/9272) · [Zep vs Mem0 benchmark dispute](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)

Confidence notes: vendor-run evals (Factory 3.70/3.44/3.35, Anthropic +29/+39%, all Mem0/Zep numbers) are claims, not reproduced facts. Governance Decay is a single preprint (deterministic grading, code released, reproduced across 3 frameworks). Claude Code internals (83.5% threshold, rehydration) are reverse-engineered and version-dependent. The Complexity Trap result and API tool-pair invariants were independently re-verified during this research.
