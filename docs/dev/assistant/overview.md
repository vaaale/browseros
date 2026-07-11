# Assistant subsystem: overview

The assistant runs on **server‑owned runs** (v2): a conversation's agent loop lives
on the server, and browsers are viewers that also execute frontend (client‑bound)
tools. CopilotKit is no longer on the chat path (it survives only as a markdown
renderer). Full design: `docs/plans/2026-07-11-assistant-v2-server-runs.md`. See also
[Actions & tools](actions-and-tools.md), [Sub‑agents](sub-agents-and-delegation.md),
and the [Assistant API](api/assistant-api.md).

---

## Request flow (server‑owned runs)

1. **`src/components/agent/v2/AssistantChatV2.tsx`** is the embeddable chat. It
   mounts `FrontendToolsV2` (binds client tool handlers), renders `MessageListV2`
   from a per‑conversation store, and `ChatInputV2`. The Assistant app
   (`src/apps/chat`) and Build Studio embed it; surface‑scoped tools are passed via
   the `tools` prop.
2. **Start a run** — `POST /api/assistant/runs { conversationId, agentId, message,
   editOfMessageId?, surfaceTools? }` → `src/lib/assistant/start-run.ts`. The
   **RunManager** (`run-manager.ts`, a `globalThis` singleton) owns one active run
   per conversation, an append‑only event log, and an `AbortController`.
3. **The loop** (`agent-loop.ts`) composes instructions, then per step: streams a
   model turn (`model-turn.ts`, raw Anthropic/OpenAI SDK, compaction applied via
   `compaction/v2.ts`), gates tools (`gate.ts` + `tools.ts` `visibleTools`), and
   executes tool calls — **server** tools inline (`tools/server/*` + the registry in
   `registry.ts`), **frontend** tools dispatched to an attached browser. Every tool
   failure/timeout/cancel returns to the model as an in‑band `Error: …` result.
4. **The browser** attaches to `GET /api/assistant/runs/[id]/events?since=` (NDJSON;
   replay + live tail), renders events, and for `tool_call{execution:"frontend"}`
   runs the bound handler through the existing tool kernel and POSTs the result to
   `.../tool-results` (first claim wins). **Stop** = `POST .../cancel` (a server‑side
   fact). The loop is the single writer of the transcript (`conversation-store.ts`).
5. **`src/app/api/llm/openai/[...path]/route.ts`** still normalizes OpenAI‑compatible
   calls (forces Chat Completions, surfaces `reasoning_content` as `<think>…</think>`).
6. **Run hooks** (`hooks.ts`) are the interception seam: `extendSystemPrompt` /
   `beforeToolCall` / `afterToolCall` / `onRunFinished`, registered globally or
   per‑run. Built‑ins: the active‑feature‑branch prompt note and background
   conversation titling (`title-hook.ts`).

---

## System instructions (`src/lib/agent/instructions.ts`)

`composeInstructions(agentId)` concatenates, in order:

1. **`CORE_POLICY`** (`src/lib/agent/config.ts`) — always‑on rules: delegation,
   Claude‑for‑dev, build‑vs‑modify, feature‑branch, memory guidance, doc‑updates,
   "VFS is not source", style.
2. **The agent's** personality (the `agentId` argument's `systemPrompt`). `agentId`
   is REQUIRED and comes from the conversation (per‑conversation agent) — there is
   no global "active agent"; a missing id throws (fail‑fast, no silent fallback).
3. **The memory snapshot** (`memorySnapshot()` — the frozen USER/MEMORY blocks; see
   [Memory](../memory/memory.md)).
4. **A skills index** (name + when‑to‑use; full bodies loaded on demand via
   `skill_load`, and bundled files via `skill_read_file`).

Delivery: the run loop calls `composeInstructions(agentId)` once per run (plus any
`extendSystemPrompt` hooks) and passes the result as the system prompt to every
model turn. Tool gating (016 allowlist + 025 deferred + Settings description
overrides) is applied per step inside the loop from the tool registry — the old
`withToolGate` model middleware is gone.

---

## The LLM layer (`src/lib/agent/llm.ts`)

Provider‑agnostic helpers used by **local sub‑agents**, the **memory loops**, and
other server features. (The main chat uses `src/lib/assistant/model-turn.ts`
instead — a streaming, abortable per‑provider turn function — but shares the same
provider config.)

- `complete({ system?, prompt, maxTokens? })` — one non‑tool completion.
- `runToolLoop({ system, prompt, tools, maxSteps?, onEvent? })` — a bounded
  tool‑use loop. `LlmTool` = `{ description?, parameters (JSON Schema), execute }`.
  Default `MAX_STEPS = 8`.

It branches on `familyOf(provider)`:

- **anthropic** → Anthropic Messages API, system prompt with `cache_control:
  ephemeral` (prefix caching).
- **openai** → Chat Completions. `messageText()` falls back to
  `reasoning_content` so "thinking" models still yield text.

Both paths use the configured `maxTokens` (never a small hardcoded cap — reasoning
models need room). On hitting the step limit they return a "review what was done,
delegate a focused follow‑up" message rather than silently stopping.

---

## Providers (`src/lib/agent/provider.ts`, `provider-meta.ts`)

- Four provider types: `anthropic`, `openai`, `openai-codex`, `openai-compatible`,
  each with a **family** (`anthropic` | `openai`), default model, base‑URL
  placeholder, and `keyRequired`. `familyOf(provider)` drives the SDK choice.
- Config (incl. the API key) persists via `provider.ts` to `data/provider.json`
  and is **masked** in API responses — never echo a key to the client.
- `hasCredentials()` gates server features that need a model (review, improve,
  title generation).

---

## Context compaction (`src/lib/agent/compaction/`)

Long conversations are compacted **as a pure view transform** over the model input
array — the client‑owned transcript at `/Documents/Chats/<id>.json` is never
rewritten (spec 022 SC‑006). Wiring point is one line in `route.ts`:

```ts
const rawModel = agentId ? serviceAdapter.getLanguageModel?.() : undefined;
const model = rawModel && convId ? withCompaction(rawModel, convId) : rawModel;
```

`withCompaction(model, convId)` uses `wrapLanguageModel` + `transformParams` from
`ai` v6. Inside the middleware the compactor applies **three layers** ordered by
increasing token pressure:

| Layer | Trigger (fraction of budget) | What it does | Cost |
|-------|------------------------------|--------------|------|
| 1. Placeholder clearing | `clearThreshold` (default 0.50) | Older tool_results (beyond the newest N pairs) get one‑line placeholders. Kept deterministic → prompt‑cache hits still land. | 0 LLM calls |
| 2. Async summarization | `summarizeThreshold` (default 0.75) | Fire‑and‑forget: an out‑of‑band summarizer runs against the client transcript, records the boundary + span hash + summary text in the sidecar. From the next turn on the view splices `<conversation_summary>…</conversation_summary>` in place of the summarized span. | 1 LLM call per boundary advance |
| 3. Mechanical fallback | `hardLimit` (default 0.92) | Synchronous truncation to keep the first user message + the largest recent pair‑safe tail below `summarizeThreshold`. Layer 2 is still scheduled so the next turn benefits. | 0 LLM calls |

State lives in `data/memory/compaction/<convId>.json` (the "sidecar"): the
boundary count, a SHA‑256 span hash (so client‑edited history invalidates the
summary — FR‑010), the summary text, the clearWatermark, and a summarization
lock. Writes are temp‑file + rename atomic.

**Constraint‑pinning invariant (FR‑017)**: the system prompt (`composeInstructions()`
output — CORE_POLICY + agent + memory + skills) is **never** compacted. The
middleware only rewrites the non‑system portion of `params.prompt`. Standing
constraints stated by the user inside the conversation are preserved by the
normative summarizer prompt (`prompts/compaction-summary-system.md`) which
requires a **Standing constraints** section be carried forward.

Config namespace `compaction` (`src/lib/config/registry.ts`) exposes every knob
to Settings and to the agent's config tools: `enabled`, `assumedContextTokens`,
`clearThreshold`, `summarizeThreshold`, `hardLimit`, `keepToolResults`,
`keepTailMessages`, `tailBudgetFraction`, `unrecoverableTools`, `model`,
`lockStalenessMs`.

021 memory‑loops is a **soft dependency**: before writing a summary the
compactor `await import('@/lib/agent/memory/fast-loop')` and, if `runFastLoop`
exists, runs it first so durable lessons hit the memory store before the raw
span is compacted away. Absence is a logged skip (US‑4.3), never a failure.

For the design rationale, benchmarks, and the exhaustive edge‑case matrix, see
[Context compaction research](context-compaction-research.md) and spec
`bos-system-specs/022-context-compaction/`. For the write‑before‑compaction
pattern with 021 see [Memory](../memory/memory.md).
