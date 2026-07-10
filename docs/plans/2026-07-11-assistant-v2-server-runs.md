# Assistant v2 — Server-Owned Runs: Analysis & Design

> Mandate: the agent must live on the server, not the UI — while still supporting
> client-side tools. Stop (mid-run, mid-tool-call) must actually work. Design must be
> solid, extensible, flexible.

---

## Part 1 — Analysis of the current architecture

### 1.1 Who owns the agent loop today: the browser

The chat path looks server-side but is not. Per request, `/api/copilotkit/route.ts:119`
builds `new BuiltInAgent({ model, prompt })` — **one model turn per POST**. Every tool the
assistant can use is registered **in the browser** via `useCopilotAction` across 18
`*Actions.tsx` files mounted by `CopilotProvider.tsx:136-153`. The actual loop is therefore:

```
browser POSTs turn → server does ONE model call → streams tool_calls back
→ browser executes handlers (sequentially) → browser POSTs results as the next turn → …
```

The browser is the loop engine. Everything hard about the Assistant follows from this:

- **Stop is not enforceable.** A "run" exists only as state inside each page's CopilotKit
  core. Any mounted surface (chat app, Build Studio embed, second tab) is an executor, and
  CopilotKit 1.62 *syncs run-activity across clients by design*. Verified framework defect
  (dist, react-core): the `useCopilotAction` wrapper drops the handler's 2nd context arg, so
  the run-abort signal never reaches handlers — queued sequential tool calls keep executing
  after Stop. No in-page latch can own a run that has N potential owners.
- **Runs die with the tab.** Close/refresh mid-run = severed loop, half-persisted turn.
- **Persistence is client-owned.** `ChatPersistence.tsx` debounce-saves `agent.messages`
  (400 ms) from whichever page is mounted. The sanitizer layer
  (`conversations-sanitize.ts`: dedupe tool calls, strip re-accumulated `<think>` blocks,
  trim stale unanswered calls, append settled-note) exists to repair the damage this
  write model allows.
- **Defensive accretion is the tell.** `RunStopGuard` (abort any run initialized while the
  kernel stop-flag is up), `RunErrorRecovery` (remount the provider on poisoned agent
  state), `ToolCallRetry` (regenerate on leaked tool-call markup), a `console.error`
  monkey-patch, and the kernel's user-stop flag are all compensations for not owning the
  loop. Each works per-page; none can work across pages.

### 1.2 What is already right (and must carry over)

- **A proven server-side loop already exists.** `runToolLoop` (`llm.ts:381-405`) drives
  sub-agents (`subagents/runner.ts`), memory fast/slow loops, and self-improve — multi-step,
  per-provider (anthropic / openai-chat / openai-responses), with deferred-tool discovery,
  in-band tool errors, and live `onEvent` streaming that already reaches the UI as NDJSON
  (`/api/subagents/delegate`). The main chat is the only agent in BOS *not* run this way.
  Gaps for chat use: no AbortSignal, no token streaming, single prompt instead of
  conversation history, no frontend-tool dispatch.
- **The tool kernel contract** (`tool-kernel.ts`): guaranteed-settle handlers, in-band
  `Error: <tool>: …` results the model can react to, configurable timeout
  (`toolCallTimeoutSec`, total for normal tools / idle for streaming ones), abort registry.
  This contract is a standing requirement and survives as the *client executor* for
  frontend tools.
- **Framework-free plumbing:** `write-queue.ts` (per-key single-writer, explicitly
  client/server/test-safe), sanitizers, `composeInstructions`, tool-gate + deferred
  discovery logic, compaction middleware, the capabilities registry.
- **Rendering:** MarkdownRenderers (Prism, HTML preview), EventCard + card-collapse
  accordion, NestedEvents (live sub-agent tools), ReasoningAssistantMessage — all consume
  plain message/tool-call data and are keepable as pure renderers.

### 1.3 Tool census — the decisive fact

Of ~60 registered tools, almost all are **fetch-wrappers**: their browser handlers just
call a server route and hand text back to the model (web search/fetch, MCP gateway, memory,
skills, docs, git, run_command, workflows, subagent delegate, config, specs, integrations,
scratchpad, self-improve…). They do not need a browser. Genuinely client-bound tools are a
small set:

| Frontend-only tool | Why |
|---|---|
| `bos_app_launch/list`, `bos_window_close`, `bos_wallpaper_set`, `bos_browser_open`, `web_view` | mutate the Zustand OS store / open windows |
| `dev_branch_request`, `agent_request_claude` elicitations | render a blocking consent card, resolve on user click |

So moving the loop server-side is not a fight against the tool surface — it *simplifies*
it: the fetch-wrappers become direct in-process calls (most already have a lib function
behind the route), and only the table above needs a dispatch-to-browser protocol.

---

## Part 2 — Design

### 2.0 Principle

**A conversation's run has exactly one owner: the server.** Stop is a server-side state
transition. Runs survive tab close. N tabs are N viewers, never N executors. One agent per
conversation (no multiplexing). The agent is ALWAYS told about tool failure — including
timeout and cancellation — as an in-band tool result.

```
Browser (any number of viewers)                Server (single owner)
┌──────────────────────────────┐               ┌─────────────────────────────────────┐
│ AssistantChat (existing UI)  │ POST /runs    │ RunManager (globalThis singleton)   │
│                              │ ─────────────►│  one active run per conversation    │
│ RunClient:                   │ NDJSON events │  event log (seq) + AbortController  │
│  · consume events → render   │ ◄─────────────│                                     │
│  · execute FRONTEND tool     │ POST          │ AgentLoop (per run)                 │
│    dispatches via the        │ tool-results  │  history+instructions → model turn  │
│    existing tool kernel      │ ─────────────►│  → server tools: execute inline     │
│  · reconnect: ?since=<seq>   │ POST cancel   │  → frontend tools: dispatch, await  │
│                              │ ─────────────►│  persist messages (single writer)   │
└──────────────────────────────┘               └─────────────────────────────────────┘
```

### 2.1 Server core (`src/lib/assistant/`)

**RunManager** — in-process registry (`globalThis` singleton, same hot-reload-safe pattern
as `run-command.ts:214`). Per conversation: at most one active run (`409` on double
start). Per run: monotonic-`seq` event log (ring buffer), `AbortController`, pending
frontend-call table, status. API: `startRun(conversationId, userMessage, attachments)`,
`cancelRun(runId | conversationId)`, `attach(runId, sinceSeq)` (async iterator: replay
then live), `submitToolResult(runId, callId, result)`, `activeRunFor(conversationId)`.

**AgentLoop** — one instance per run:

1. Load conversation (server-side, sanitized on load), append the user message, persist.
2. Compose instructions (`composeInstructions(agentId)` + feature-branch note — logic
   lifted unchanged from today's `/api/copilotkit` route).
3. Loop until final text, step cap, or abort:
   - `streamModelTurn(...)` with the run's signal; forward `text_delta` /
     `reasoning_delta` events as they stream.
   - For each tool call: gate-check (allowlist + deferred-revealed set — the
     `withToolGate` logic moves here, where the tools live), then:
     - **server tool** → `execute(input, { signal, onEvent })` inline, kernel-style
       guarantees (catch everything, timeout, in-band error string).
     - **frontend tool** → emit `tool_call{execution:"frontend"}`, await a claimed result
       or `toolCallTimeoutSec` → in-band
       `Error: <tool>: no client executed the tool within …s`.
   - Persist the finalized assistant message + tool results (single writer), emit
     `message` + `tool_result` events, next step.
4. Leak-retry lives here: a turn whose *text* contains tool-call markup is retried
   (bounded), replacing client-side `ToolCallRetry`.
5. `run_finished {reason: completed | cancelled | error | max_steps}` — always emitted,
   always persisted consistently.

The loop takes `streamModelTurn` as an injected step function → unit-testable with a
scripted fake provider, no LLM.

**streamModelTurn** (`model-turn.ts`) — extracted from `llm.ts` + the adapters, per
provider family, but: streaming, `AbortSignal` end-to-end (both SDKs accept
`{ signal }`), full message-history input, existing quirks preserved (jinja dummy-user
guard, `reasoning_content`, token-param selection, undici streaming workaround).
`withCompaction` wraps it exactly as it wraps the model today. Sub-agents and memory
loops migrate to it opportunistically later; `runToolLoop` stays untouched for them now.

### 2.2 Tool registry — one source of truth

`src/lib/assistant/tools.ts` (framework-free):

```ts
interface AssistantTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  execution: "server" | "frontend";
  execute?: (input, ctx: { signal, conversationId, agentId, onEvent }) => Promise<string>; // server tools
}
```

- **Server tools:** ported from the fetch-wrapper handlers to direct lib calls
  (`web-search.ts`, MCP gateway, memory store, skills store, workflows, subagent runner…).
  Streaming tools (`agent_delegate`, `workflow_run`) forward their progress through
  `ctx.onEvent` → nested events become *run events* (today's client-side NDJSON relay and
  `encodeNested` dance disappears; the delegation store is fed from the run stream).
- **Frontend tools:** declaration lives in this same module; the client imports it and
  binds handlers **by name** — adding a tool = one entry (+ one handler if frontend).
- **Gating** (016 allowlist + 025 deferred + metadata overrides) is applied by the loop
  from this registry; the capabilities registry becomes derived-from/aligned-with it.

### 2.3 Transport & events

NDJSON over fetch streams — the pattern BOS already uses and the kernel already parses.
No new dependency; CopilotKit's GraphQL runtime leaves the chat path.

- `POST /api/assistant/runs` `{conversationId, agentId, message}` → `{runId}` (starts the
  loop detached from the request; `202`-style).
- `GET /api/assistant/runs/[runId]/events?since=<seq>` → NDJSON replay + live tail.
- `POST /api/assistant/runs/[runId]/cancel`
- `POST /api/assistant/runs/[runId]/tool-results` `{callId, result}` (first claim wins;
  duplicates ignored)
- `GET /api/assistant/runs?conversationId=` → active run, if any (reconnect/reload path).

Events (each `{seq, ts, type, …}`): `run_started`, `text_delta{messageId,delta}`,
`reasoning_delta`, `tool_call{callId,name,args,execution}`, `tool_progress{callId,event}`
(nested sub-agent/workflow events), `tool_result{callId,result}`, `tool_cancelled{callId}`,
`message{message}` (finalized), `state_patch{patch}`, `run_finished{reason,error?}`.

### 2.4 Stop — exact semantics

Stop button → `POST …/cancel` → `AbortController.abort()`. Then, deterministically:

- **Mid model turn:** signal tears down the provider stream. Streamed-so-far text is
  finalized as an assistant message marked stopped; **not-yet-executed tool calls from
  that turn are dropped** (the persisted transcript never contains unanswered calls — the
  existing sanitizer contract, now enforced at write time).
- **Mid server tool:** the tool's `signal` fires; the loop records
  `Cancelled by user.` as that call's in-band result and finishes the run.
- **Mid frontend tool:** server emits `tool_cancelled`, records `Cancelled by user.` as
  the result, finishes the run. The client kernel aborts the in-flight handler
  (existing `abortActiveToolRuns`) — but the run is over *regardless of whether any client
  reacts*.
- **Queued calls never start.** The loop checks the signal between every await.
- `run_finished{cancelled}` goes to every attached viewer; stop from ANY tab stops for
  all. After `cancel` returns, no further model turn can start — this is a server-side
  invariant, not a client latch. The kernel's user-stop flag, RunStopGuard, and the
  cross-tab problem cease to exist.

### 2.5 Persistence — server single-writer

The loop is the **only** writer of message history: `enqueuePerKey(conversationId, …)`
(existing module, already framework-free) + atomic write to
`/Documents/Chats/<id>.json`. Sanitizers run server-side on load. The browser stops
writing messages entirely — `ChatPersistence`, debounced saves, and the RUN_ERROR
emergency flush all retire. Conversation *metadata* ops (rename/delete/select, active
pointer in localStorage) stay client-side initially and move behind
`/api/assistant/conversations` in a later milestone.

Reload mid-run: page loads history from disk, asks `GET /runs?conversationId=`, attaches
`?since=0`, replays, continues live. Tabs are stateless viewers.

### 2.6 Client (`run-client.ts` + rewiring)

- `RunClient`: start/attach/reconnect/cancel; feeds a per-conversation **message store**
  (plain React/Zustand state: persisted messages + in-flight deltas + tool-call status);
  claims frontend `tool_call` dispatches and executes them through the **existing tool
  kernel** (`runToolHandler` — timeouts, in-band errors, settle guarantees unchanged).
- `AssistantChat` keeps its component API (`agentId`, `showConversations`, …) so the chat
  app **and the Build Studio embed migrate for free**; the message list renders from the
  store via the existing renderers (EventCard from tool-call data, reasoning splitter as a
  pure renderer, markdown as-is).
- Elicitation tools (`dev_branch_request`, `agent_request_claude`) become frontend tools
  whose handler renders the existing blocking card in the transcript and resolves on user
  choice — same UX, no `renderAndWaitForResponse`.
- Multiple viewers: dispatches are claimed (first `tool-results` wins); OS-mutating tools
  execute on the claiming tab.

### 2.6b Surface-scoped frontend tools (Build Studio et al. — user requirement, 2026-07-11)

Build Studio registers app-scoped tools inside the embed's provider
(`src/apps/build-studio/AgentTools.tsx`: `buildstudio_artifact_open`,
`buildstudio_tree_refresh`, `buildstudio_run_tests`) whose handlers close over app UI
state (`openFile`, `loadTree`). v2 makes this pattern explicit:

- `POST /api/assistant/runs` accepts `surfaceTools?: ToolDeclaration[]`
  (name/description/parameters) — the starting surface contributes them for THAT run.
  The loop merges them into the gated toolset as `execution:"frontend"` tools.
- Their dispatches are claimed by the contributing surface's RunClient (which registered
  the handlers); if that surface is gone → standard in-band timeout error.
- `AssistantChat` keeps a `tools` prop (declaration + handler pairs) replacing the
  children-slot `useCopilotAction` pattern; Build Studio passes its three tools there.
- Semantics match today: surface tools exist only while the surface is mounted, invisible
  to other agents/conversations.

### 2.6c Server-side run hooks (user requirement, 2026-07-11 — IMPLEMENTED with Milestone A)

`src/lib/assistant/hooks.ts` — the interception seam for features and embedding
surfaces. `RunHooks = { extendSystemPrompt, beforeToolCall, afterToolCall,
onRunFinished }`; registered globally (`registerRunHooks(id, hooks)` — applies to
every run; hot-reload-safe) or per-run (in-process starters via
`startAssistantRun({ hooks })`). Composition: prompt extensions concatenate,
first tool-call deny wins (deny → in-band `Error: <tool>: blocked: …` result),
observers fan out. Every hook invocation is caught + time-boxed (10 s) — a broken
hook can never wedge a run. First built-in consumer: the active-feature-branch
prompt note. HTTP embeds don't get code hooks; their interface is the runs API +
event stream + surfaceTools.

### 2.7 Edit & resubmit the last user message (user requirement, 2026-07-11)

Must work **even when the message has no agent response** (run failed/stopped/died after
send — i.e. the transcript simply ends in a user message).

- `POST /api/assistant/runs` accepts optional `editOfMessageId`. Server-side, under the
  conversation's write queue: verify it is the **last user message**, truncate the
  transcript from it (inclusive, dropping any later assistant/tool messages), append the
  edited message, persist, start a fresh run.
- If a run is active for the conversation, the edit request **auto-cancels it first**
  (normal cancel path), then truncates — "stop, fix, resend" is one action.
- `run_started` carries `truncatedFromMessageId?` so attached viewers drop the stale tail
  from their local store; reloading tabs get corrected history from disk.
- UI (Milestone B): edit affordance on the last user message; resubmit posts with
  `editOfMessageId`.

### 2.8 Session/shared state (capability parity with AG-UI)

Per-conversation `state` document owned by the RunManager: `state_get` / `state_set`
server tools + `state_patch` events; surfaced to InfoPanel. Same capability as
CopilotKit's shared state, without the client state machine.

### 2.9 What retires

`CopilotProvider` + CopilotKit chat transport, `/api/copilotkit` route + adapters +
`BuiltInAgent` construction, `ChatPersistence`, `RunStopGuard`, `RunErrorRecovery` +
`recoveryGen`, `ToolCallRetry` (logic moves into the loop), the `console.error` patch,
`withToolGate` middleware (logic moves into the loop), the kernel's user-stop *flag*
(the abort registry stays — it serves frontend-tool execution).

### 2.10 Why this is solid, extensible, flexible

- **Solid:** one owner, one writer, one event log. Stop, reconnect, and multi-tab are
  properties of the architecture, not patches. The loop is unit-testable with a scripted
  provider; no framework internals to monkey-patch.
- **Extensible:** a tool is one registry entry; a new provider is one `streamModelTurn`
  family; nested agents/workflows already fit the event model (`tool_progress`); headless
  runs (scheduler, cron agents, workflows) can start runs with **no browser at all** —
  frontend tools simply time out in-band, which is exactly the desired semantics.
- **Flexible:** viewers are cheap (future: mobile surface, supervisor dashboards attach to
  the same stream); event log enables replay/audit; session state is a server document any
  surface can subscribe to.

### 2.11 Milestones (each: tsc + lint green, user checkpoint, commit)

- **A — Server core.** RunManager, AgentLoop, `streamModelTurn` extraction, run routes.
  Scripted-provider unit specs: loop happy path, stop mid-turn / mid-server-tool /
  mid-frontend-dispatch, no-client timeout, leak-retry, persistence invariants.
- **B — Client.** `run-client.ts`, message store, `AssistantChat` rewired (same props),
  rendering from store incl. tool cards + reasoning + nested progress.
- **C — Tool port.** All Actions files → registry entries (server execute or frontend
  binding); elicitation cards; delete `useCopilotAction` usage.
- **D — Retirement.** Remove CopilotKit chat path + defensive machinery; conversation
  metadata APIs server-side; docs + system spec update.
- **E — e2e.** Stop kills the loop server-side (assert via file + a second attached
  client), two-tab stop, reconnect replay, no-client frontend-tool timeout, hung-tool
  in-band error (port of existing spec).

### Decisions (user, 2026-07-11)

1. **Partial text on stop: DISCARD the whole partial turn.** On cancel mid-model-turn,
   nothing from the interrupted turn is persisted — the transcript ends at the last
   completed message. (Live viewers still see the streamed text until `run_finished`;
   it simply isn't saved.)
2. **Message-shape contract kept** — persisted message objects stay compatible
   (role/content/toolCalls/feedback), so thumbs feedback and the fast-loop integration
   are untouched, and historical conversations render unchanged.
3. **Chat `maxSteps`: configurable per agent, default 24**, in-band step-limit message
   (same wording as `runToolLoop`).

### Rendering-parity requirement (user, 2026-07-11)

The client must keep rendering everything the CopilotKit stream shows today —
reasoning/thinking, live tool-call cards with streamed args, results, nested sub-agent
events — via the same renderer components, fed from run events:
`text_delta`→markdown, `reasoning_delta`→ReasoningAssistantMessage,
`tool_call`/`tool_result`→EventCard, `tool_progress`→NestedEvents. Frontend tools remain
fully functional through the claim/execute/post-result protocol (§2.6), executed by the
existing tool kernel.
