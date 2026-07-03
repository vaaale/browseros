# Assistant subsystem: overview

The assistant is built on **CopilotKit**. This page covers the request flow, how
the system instructions are composed, and the provider‑agnostic LLM layer. See also
[Actions & tools](actions-and-tools.md), [Sub‑agents](sub-agents-and-delegation.md),
and the [Assistant API](api/assistant-api.md).

---

## Request flow

1. **`src/components/agent/CopilotProvider.tsx`** wraps the desktop in
   `<CopilotKit runtimeUrl="/api/copilotkit" threadId={activeConversationId}>` and
   mounts all `*Actions` components (which register tools). Switching conversation
   switches `threadId`.
2. **`src/apps/chat/index.tsx`** renders `<CopilotChat>` with composed
   `instructions` (fetched from `/api/assistant/agent`), the
   `ReasoningAssistantMessage` renderer, and `markdownRenderers`. It also mounts
   `<ChatToolRenderer>`, the conversation panel, the info panel, and the agent
   selector, and uses `useChatPersistence` to load/save messages per conversation.
3. **`src/app/api/copilotkit/route.ts`** builds the runtime + adapter **per request**
   (so Settings changes apply with no restart):
   - **Anthropic family** → `AnthropicAdapter` (prompt caching on; `maxInputTokens`
     from config).
   - **OpenAI family** → `OpenAIChatAdapter` pointed at the in‑app proxy
     `${origin}/api/llm/openai` (keeps the real key server‑side).
4. **`src/lib/agent/runtime.ts`** (`buildRuntimeOptions`) wires configured MCP
   servers (+ the managed browser‑automation server when enabled) so their tools
   are auto‑exposed.
5. **`src/app/api/llm/openai/[...path]/route.ts`** normalizes OpenAI‑compatible
   calls: forces **Chat Completions** (not Responses), injects `max_tokens`, and
   surfaces `reasoning_content` as `<think>…</think>` so reasoning models stream
   content.

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

Delivery (CopilotKit 1.61 caveat): the `<CopilotChat instructions>` prop is NOT
forwarded to the model on the v2 `BuiltInAgent` path. Instead `/api/copilotkit`
reads the conversation's agent from `?agent=<id>`, calls `composeInstructions`,
and constructs the default `BuiltInAgent({ model, prompt })` with it — that
`prompt` is what actually reaches the LLM. `CopilotProvider` keys `<CopilotKit>`
on the agent id so a fresh runtime client binds the correct `?agent=` on switch.

---

## The LLM layer (`src/lib/agent/llm.ts`)

Provider‑agnostic helpers used by the **review pass**, **local sub‑agents**, and
other server features (the *chat* itself goes through CopilotKit's adapters):

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
