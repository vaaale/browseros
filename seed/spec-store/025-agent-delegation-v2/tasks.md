# Tasks: Agent Delegation v2 (025)

**Input**: `specs/bos-system-specs/025-agent-delegation-v2/spec.md`, `plan.md` (both revised after independent review — see `spec-review.md`/`plan-review.md`, all findings resolved; logging integration per FR-027 added throughout).

**Prerequisites**: spec.md and plan.md reviewed and approved.

**Organization**: Tasks are grouped by plan.md's phases, which are dependency-ordered, not by team-parallelizable user story — Phase 2 (primitives) blocks everything, Phase 3 IS the actual bug fix (US-1/US-2/US-3), Phase 4 (retire legacy) must follow Phase 3 so there's never a window with no working delegation, Phase 5 (surface agents, US-4/US-5) depends on all three.

## Phase 1: Setup

- [X] T001 Confirm the active feature branch is `025-agent-delegation-v2` (or create it); confirm `spec.md`/`plan.md`/`spec-review.md`/`plan-review.md` are all readable from the working tree.
- [X] T002 Re-read `src/lib/assistant/agent-loop.ts`, `run-manager.ts`, `gate.ts`, `tools.ts`, `registry.ts`, `tools/server/subagents.ts`, `tools/server/discovery.ts`, and `agent/subagents/{types,runner,tools,store}.ts` in full before touching anything — the plan's Current-state audit found several places where the code had already moved since the spec was drafted; confirm nothing has moved again since the plan was written. Also skim `src/lib/logging/{index,server-logger,client/browser-logger}.ts` and `src/app/api/logs/route.ts` — the logging infrastructure this feature integrates with (FR-027) already exists in full; this phase does not build any of it.

---

## Phase 2: Foundational — Shared primitives (blocks every later phase)

**Purpose**: Build the inner-loop execution primitive and its supporting pieces. Nothing in Phase 3+ can be implemented correctly without this.

**Independent Test**: Unit-test `runInnerLoop` standalone (scripted `streamTurn`, in-memory `io`, a fake parent `Run`) — verify blank-slate task seeding, live event shaping, `max_steps` reuse of `STEP_LIMIT_TEXT`, and depth-guard rejection — with no real agent, tool registry, or HTTP route involved yet.

### Implementation

- [X] T003 Add `delegationDepth?: number` to `ToolContext` (`src/lib/assistant/tools.ts:19-26`) and to `AgentLoopDeps` (`src/lib/assistant/agent-loop.ts:54-74`).
- [X] T004 In `runServerTool`'s ctx construction (`agent-loop.ts`, inside the tool-call loop around line 266), pass `delegationDepth: deps.delegationDepth ?? 0` through to every server tool's `ToolContext`.
- [X] T005 Fix the idle-timeout orphaning bug in `runServerTool` (`agent-loop.ts:96-141`, plan-review P1): construct a per-call `AbortController` there; link it to abort when the run's real signal (`deps.signal`) aborts (`{once:true}`), AND self-abort it the moment the internal idle timer fires — right before `settle(toolError(...))`. Pass this controller's `.signal` as `ctx.signal` to `tool.execute()` instead of the bare run signal. **Logging (FR-027)**: at the same point the idle timer fires (right before `settle(...)`), call `logger().warn("assistant.tools", "server tool timed out", { conversationId: deps.conversationId, agentId: deps.agentId, tool: tool.name, timeoutMs })` — this event is currently invisible outside the in-band error string returned to the model, so an unattended/headless caller has zero trail today.
- [X] T006 [P] Unit test `src/lib/assistant/__tests__/agent-loop.test.ts` (hand-run, `assert()`-based, `runAll()` entry — matches `src/lib/agent/scratchpad/__tests__/handlers.test.ts`'s convention; no runner is wired into `package.json`, don't add a vitest/jest suite): drive `runAgentLoop` directly with a fake `AssistantTool` whose `execute()` never resolves and a tiny `toolTimeoutMs`; assert (a) the tool call settles with the in-band `"no result within Ns"` error exactly as today, (b) the `ctx.signal` passed to that tool's `execute()` is observed to abort once the timeout fires (plan Risk 3 — the actual regression this test guards), and (c) the new `assistant.tools` "server tool timed out" log record (T005) is emitted with `{conversationId, agentId, tool, timeoutMs}`. This exercises T005's change on a NON-delegation tool specifically, since that construction now affects every server tool call.
- [X] T007 Add a `toolTimeoutMs: number` field to `Run` (`src/lib/assistant/run-manager.ts`); set it once in `start-run.ts` alongside `run.tools` (near line 88's `Object.assign(run.tools, assistantTools())`).
- [X] T008 [P] Extend `StreamTurn`'s options (`agent-loop.ts:36-45`) with an optional `model?: string`.
- [X] T009 [P] Extend `getProviderConfig` (`src/lib/agent/provider.ts:46`) to accept an optional `modelOverride?: string`, substituting it for the resolved `model` field only (provider/apiKey/baseUrl unchanged).
- [X] T010 Thread `opts.model` from `streamModelTurn` (`src/lib/assistant/model-turn.ts:22`) into the new `getProviderConfig(opts.model)` call.
- [X] T011 [P] Factor the "## Skills" / "## MCP servers" index-building logic out of `composeInstructions` (`src/lib/agent/instructions.ts:24-59`) into a small shared, **unset-aware** helper (treat an `undefined` allowlist as "build the index from every skill/server," not "skip the section" — plan-review P3) reusable by both `composeInstructions` and the new ephemeral-agent prompt builder (T014).
- [X] T012 Create `src/lib/assistant/delegation-gate.ts` with three gate builders:
  - Named: `gateFor(agentId)` reused unchanged.
  - Ephemeral: `{ allow: serverOnly(parentGate.allow, tools), deferred: new Set(), registryIds: parentGate.registryIds, descriptions: parentGate.descriptions }`, `serverOnly = ids filtered to tools[id]?.execution === "server"`.
  - Surface: `{ allow: new Set(surfaceAgent.toolNames), deferred: new Set(), registryIds: parentGate.registryIds, descriptions: parentGate.descriptions }`.
- [X] T013 In the same file (or a sibling), add the named-agent `composeSystem` builder: reuse `composeInstructions(agentId)` unchanged (a deliberate small upgrade over today's bare-`agent.systemPrompt` legacy behavior — see plan Risk 2).
- [X] T014 Add the ephemeral-agent `composeSystem` builder: `agent.systemPrompt` verbatim + the T011 skills/mcp index blocks filtered to the inherited ids, no default-prompt prepending, no memory snapshot.
- [X] T015 Add the surface-agent `composeSystem` builder: `agent.systemPrompt` verbatim, nothing appended.
- [X] T016 Create `src/lib/assistant/inner-loop.ts`: `InnerLoopSpec` type (`systemPrompt`, `gate`, `model?`) + `runInnerLoop(parentRun, ctx, spec, task, maxSteps)`:
  - `io`: in-memory, `loadMessages()` → `[]`, `saveMessages()` captures into a closure variable; task enters via `runAgentLoop`'s own `AgentLoopInput.userMessage`, not manual seeding.
  - `emit`: shape down to `{tool, input}` (legacy `ToolEvent` shape) from `tool_call`-type events only, forwarded via `ctx.onEvent` — NOT a raw forward of every `RunEventInput` (plan-review P2; verified the existing `ToolCallCard.tsx` live-progress path already expects exactly this shape, so no new frontend work is needed as long as this shaping is correct).
  - `tools`: `parentRun.tools`. `awaitFrontendResult`: bound to `parentRun`. `signal`: `ctx.signal` (now correctly per-call, per T005). `toolTimeoutMs`: `parentRun.toolTimeoutMs` (T007).
  - `streamTurn`: `e2eScriptedTurn(task) ?? streamModelTurn` (`src/lib/assistant/e2e-provider.ts:52`, imported and reused as-is — same pattern `start-run.ts:117` already uses with `opts.message`). This is what makes every e2e test in Phase 3/5 below possible without a live model: an `@@e2e {"turns":[...]}` string passed as the delegation's `task` scripts the inner loop's own model turns.
  - `maxSteps`: caller-supplied (see T017 for the default heuristic).
  - Result mapping: `completed` → last assistant message content verbatim; `max_steps` → reuse `STEP_LIMIT_TEXT` as-is; `cancelled` → fixed "Delegation cancelled." string; `error` → `result.error`.
- [X] T017 In `inner-loop.ts`, add the `maxSteps` default heuristic: reuse today's `DEV_MAX_STEPS = 40` logic (port `runner.ts:94-95`'s `isExtended` check — dev/spec-style tools in the resolved set) else a smaller default (12); and the depth-guard constant `MAX_DELEGATE_DEPTH = 2` (moved from `runner.ts:21`) + the `>= MAX_DELEGATE_DEPTH` rejection returning `"Delegation depth limit reached; cannot nest another delegation."`. **Logging (FR-027)**: immediately before returning that rejection string, call `logger().warn("assistant.delegate", "delegation depth limit reached", { conversationId, agentId, depth })` — today this path (the legacy `dev_delegate` guard, `runner.ts:42`) logs nothing at all, so this closes a genuinely silent-to-the-log failure mode, not a cosmetic addition.
- [X] T018 [P] Unit test `src/lib/assistant/__tests__/inner-loop.test.ts` (hand-run, same convention as T006): call `runInnerLoop` directly against a fake parent `Run` (in-memory `tools`, a stub `awaitFrontendResult`, a real `AbortController` for `abort.signal`) and a scripted `task` string (`@@e2e {"turns":[...]}"`, `BOS_E2E_SCRIPTED=1` set for the test process) covering: blank-slate task seeding (the fake `Run` has pre-existing unrelated conversation state that must NOT leak in); `{tool,input}` event shaping reaching a captured `onEvent` array (assert the SHAPE, not raw `RunEventInput`); a script with more tool-call turns than `maxSteps` returns the exact `STEP_LIMIT_TEXT`; depth-guard rejects at the boundary AND emits the T017 log record; calling `parentRun.abort.abort()` mid-script settles the inner loop as `cancelled`.
- [X] T019 `npx tsc --noEmit` and `npm run lint`; fix every error before moving to Phase 3.

**Checkpoint**: `inner-loop.ts` works standalone against a scripted provider; nothing in the primary run path (`start-run.ts`, existing e2e suite) has changed behavior yet.

---

## Phase 3: User Stories 1–3 — Rewire `agent_delegate`, add `dev_delegate` (the actual bug fix)

**Purpose**: This is the change that fixes the motivating bug — delegated execution stops silently dropping v2-only tools, ephemeral delegates stop getting zero tools, and multi-step delegations stop polluting the transcript.

**Independent Test**: Delegate to an agent whose `AGENT.md` lists a v2-only tool (e.g. `ui_preview_render`) and confirm it's actually callable in the delegated run. Delegate with only ephemeral fields and confirm the resulting persona has tools immediately. Delegate a task that takes 5+ internal steps and confirm the parent transcript gains exactly one `tool_call`/`tool_result` pair, with the internal steps visible live as nested progress.

### Implementation

- [X] T020 Rewrite `agent_delegate`'s `execute()` in `src/lib/assistant/tools/server/subagents.ts` (currently lines 73-116): keep the input schema, ephemeral-spec construction, and `encodeNested()` wrapping unchanged; replace the body for `type: "local"` to: resolve named/ephemeral spec → build gate (T012) + `composeSystem` (T013/T014) + `model` (named only) → depth-guard check (T017) → `runInnerLoop(...)` (T016) → map the result into the same `"[agent · type] N step(s)\n\n<output>" + encodeNested(...)` shape the tool produces today. `type: "claude"` keeps calling `runClaudeAgent` completely unchanged.
- [X] T021 Create `src/lib/assistant/tools/server/dev-delegate.ts`: a new `dev_delegate` server tool — fixed target `getAgent("developer")`, same depth guard + `runInnerLoop` as T020. **Keep the id `dev_delegate`** (already the real, live id — `subagents/tools.ts:218`'s `DELEGATE_TO_DEVELOPER` constant, and every seeded skill/agent already references it — this is completing an existing id, not a rename). Register it in `assistantTools()` (`src/lib/assistant/registry.ts`).
- [X] T022 **Logging (FR-027)** — delegation lifecycle: in T020/T021's `execute()` (wrapping the `runInnerLoop` call for both tools), log on start — `logger().log({ level: "info", component: "assistant.delegate", conversation: ctx.conversationId, msg: "delegation started", data: { kind: "named"|"ephemeral"|"surface", agentId, depth, maxSteps } })` — and on finish, the mirrored record — `msg: \`delegation finished: ${reason}\``, `data: { agentId, kind, steps, reason }`, `level: reason === "error" ? "error" : "info"`, plus `err: result.error` on error. This deliberately mirrors `start-run.ts:98-104,130-136`'s existing "run started"/"run finished: reason" shape for consistency in Settings → Logs. **Never log the `task` string or any tool arguments/results** — metadata only, matching `assistant.run`'s existing precedent.
- [X] T023 Tool-id validation surfacing for named agents (FR-023/FR-027): in the agent load/save path (`src/lib/agent/subagents/store.ts`) or gate construction (`gate.ts:gateFor`), validate every configured `tools`/`deferredTools` id against `assistantTools()`; on any unresolved id, call `logger().warn("assistant.agents", "agent references unresolved tool ids", { agentId, unresolvedIds })` AND collect them into a per-agent list surfaced in Settings → Agents (existing agent editor — no new page). Valid ids in the same list must keep working (partial, not total, failure).
- [X] T024 `npx tsc --noEmit` and `npm run lint`.
- [X] T025 Manual verification against the ORIGINAL failing trajectory that started this spec: the default "assistant" agent delegating to a `build-studio`-style agent whose allowlist includes `ui_preview_render`/`a2ui_render` — confirm they're actually callable in the delegated run now (US-1, SC-001).
- [X] T026 [P] Create `e2e/025-agent-delegation.spec.ts` (Playwright, request-fixture — no browser needed, mirrors `e2e/run-events-replay.spec.ts`'s `POST /api/assistant/runs` → poll for finish → `GET .../events` pattern). Two `test()` blocks:
  - **"delegating to an agent whose allowlist includes a v2-only tool resolves it" (US-1, SC-001 — the actual regression this whole spec exists to fix)**: `POST /api/assistant/runs` with `message: '@@e2e {"turns":[{"text":"delegating","tools":[{"name":"agent_delegate","args":{"agent":"build-studio","task":"@@e2e {\\"turns\\":[{\\"text\\":\\"rendering\\",\\"tools\\":[{\\"name\\":\\"ui_preview_render\\",\\"args\\":{\\"surfaceId\\":\\"s1\\",\\"operations\\":[]}}]},{\\"text\\":\\"done\\"}]}"}}]},{"text":"Delegated."}]}'` (note the nested, escaped `@@e2e` script inside the `task` argument — this is what T016's `streamTurn` wiring makes possible). Poll `GET /api/assistant/runs?conversationId=...` until finished, then `GET /api/assistant/runs/{runId}/events?since=0` and assert NO event's `tool_result` for `ui_preview_render` (or the `agent_delegate` call itself) contains `"unknown tool"` or `"Error:"` — confirming the tool actually resolved inside the inner loop instead of silently vanishing.
  - **"an ephemeral delegate can call a tool inherited from the parent's allowlist immediately" (US-2, SC-002)**: same shape, `agent_delegate`'s `args` uses `{ephemeralName:"Quick Helper", ephemeralSystemPrompt:"...", ephemeralType:"local", task:"@@e2e {...}"}` where the nested script calls a tool known to be in the "assistant" agent's allowlist (e.g. `memory_search`) with no prior `find_tools` call; assert the same "no unknown-tool/error" outcome, proving immediate inheritance (FR-003/FR-004).
- [X] T027 In the same `e2e/025-agent-delegation.spec.ts` file T026 creates (sequential with it, same file — NOT `[P]`), add: **"a multi-step delegation collapses to exactly one tool_call/tool_result" (US-3, SC-005, Example 3)**: the delegation's nested script has 3 turns, each calling a trivial tool (e.g. `memory_search`), before a final no-tool turn. After the run finishes, `GET /api/assistant/conversations/{conversationId}/messages` and assert exactly ONE message with `role:"assistant"` carrying a `toolCalls` entry named `agent_delegate` and exactly ONE `role:"tool"` message answering it — NOT one per inner step.
- [X] T028 [P] Create `e2e/025-nested-progress.spec.ts` (Playwright, browser-fixture — mirrors `e2e/013-ui-preview.spec.ts`'s open-chat-and-send-scripted-message pattern): open the Assistant window, send a scripted message whose `agent_delegate` task script gives each inner turn a `delayMs` (e.g. 300ms) so the run stays open long enough to observe; WHILE the run is still in flight (before `run_finished`), assert the `agent_delegate` tool-call card (`getByTestId`/`data-tool="agent_delegate"` per `ToolCallCard.tsx`) shows the `running` state AND at least one live nested entry (`toNestedEvents`'s `{tool, input}` rendering) — this is the concrete UI check that T016's event-shaping (not just the transport) actually works, closing plan-review P2. Do not assert on any LLM-generated text, only on the deterministic scripted tool names.
- [X] T029 In `e2e/025-agent-delegation.spec.ts` (sequential with T026/T027, same file — NOT `[P]`), add: **"an inner loop that exhausts its step cap returns the step-limit summary, not a hang" (US-3 scenario 3, SC-008, Example 6)**: nested script has MORE tool-call turns than the ephemeral `maxSteps` default from T017 (e.g. `maxSteps + 3` turns, each with a trivial tool call, no final no-tool turn) and NO delegate-target-specific dev/spec tools (so the smaller default applies, not `DEV_MAX_STEPS`). After the run finishes, assert the `tool_result` for `agent_delegate` contains `"Reached the step limit"` (the exact `STEP_LIMIT_TEXT` wording) rather than truncating silently or hanging past the test's timeout.

**Checkpoint**: Delegation (named + ephemeral) is fully working end-to-end through the NEW inner-loop path. The legacy engine still exists underneath but is no longer load-bearing for anything `agent_delegate`/`dev_delegate` do.

---

## Phase 4: Retire the legacy engine

**Purpose**: Now that nothing depends on `runLocal`/`toolsFor()` for correctness, delete them — this is what makes FR-001 ("exactly one tool-resolution registry") actually true, not just true for the new code paths.

**Independent Test**: `grep -r "subagents/tools" src/` returns nothing outside files this phase deletes. Every existing persisted agent's `tools`/`skills`/`mcp`/`deferredTools` behavior is unchanged from Phase 3's end state.

### Implementation

- [X] T030 Move `DEV_TOOLS`'s three implementations (`bos_source_list`/`bos_source_read`/`bos_source_search`) from `src/lib/agent/subagents/tools.ts` directly into `src/lib/assistant/tools/server/dev-source.ts` as native `AssistantTool`s; drop the `adaptLlmTools(DEV_TOOLS, [...])` indirection.
- [X] T031 Port `SCHEDULER_TOOLS` (`src/lib/agent/scheduler/agent-tools.ts`) into a new `src/lib/assistant/tools/server/scheduler.ts` using the same `adaptLlmTools()` pattern T030 demonstrates; register in `assistantTools()`. This makes the tools EXIST in the registry — it does NOT by itself grant them to any agent (see T032).
- [X] T032 Seeded-allowlist migration audit: grep `data/agents/*/AGENT.md` and `seed/agents/*/AGENT.md` for ids whose meaning or existence changes under this migration:
  - Scheduler ids (T031) — decide per-agent whether to add them to an allowlist; this is a deliberate content decision, not automatic.
  - `file_read`/`file_write`/etc. — confirm no seeded agent depends on the old server-side (headless) VFS semantics for a scheduled/unattended delegation context (they become frontend-dispatch-only under this migration, plan Current-state-audit).
  - Stale pre-016 CopilotKit-era ids — concretely confirmed present today in `data/agents/build-studio/AGENT.md`'s `tools:` list (`listSpecs`, `openSpecArtifact`, `delegateToSubAgent`, and others that already silently fail to resolve). Clean these up now, since T023's validation will surface them for the first time.
- [X] T033 Grep the repo for any consumer of `src/lib/agent/subagents/tools.ts` beyond `dev-source.ts` (T030) and `runner.ts`; resolve any found before deleting.
- [X] T034 Delete `src/lib/agent/subagents/tools.ts` in full (`ALL_TOOLS`, `toolsFor`, `SUBAGENT_TOOLS`, `makeDiscoveryTools`, `pickDeferredIds`, `STATIC_SCHEMAS`, `getToolSchema`).
- [X] T035 In `src/lib/agent/subagents/runner.ts`: delete `runLocal`, `makeDelegateTool`, `makeRunCommandTool`, `DEV_MAX_STEPS` (the depth-guard constant already moved to `inner-loop.ts` in T017 — confirm it's gone from here too, and confirm no logging was quietly lost in the deletion — there wasn't any to begin with, per the plan's Current-state audit, but re-verify). Shrink `runSubAgent` to just the `type === "claude"` branch (`runClaudeAgent`) — keep the function's name/shape so `claude-runner.ts` and its callers are untouched.
- [X] T036 `npx tsc --noEmit` and `npm run lint`.
- [X] T037 Run the FULL existing e2e suite (not just this feature's new tests) to confirm no regression from deleting the legacy engine.

**Checkpoint**: `src/lib/agent/subagents/tools.ts` no longer exists. Exactly one tool-resolution registry remains, for every execution context.

---

## Phase 5: User Stories 4–5 — Surface agents

**Purpose**: Let a mounted app window register a window-scoped delegate persona with its own bounded Tier-2 toolset, discoverable only while the window stays open.

**Independent Test**: Open UI Preview, delegate a design task to its registered surface agent, confirm the mockup updates live in the same window; close the window; confirm the agent is no longer discoverable and a stale delegation attempt fails with a clear error. Two windows of the same app registering the same-named surface agent both remain independently delegatable.

### Implementation

- [X] T038 Create `src/lib/assistant/client/surface-agents.ts`, mirroring `client/surface-tools.ts`:
  - `registerSurfaceAgent(windowId, {name, description, systemPrompt, toolNames})`: derive `id = slugify(name)`. **Registration-time persisted-id collision check** (FR-023's actual requirement — plan-review C1): `fetch("/api/subagents")` (existing endpoint, `GET` → `{subAgents: Agent[]}`) and compare `id` against the returned persisted ids; on collision, REJECT synchronously — never add it to the registry — and log it via `clog("warn", "assistant.surface-agents", "surface agent registration rejected: id collides with a persisted agent", { windowId, id, name })` (`src/lib/logging/client/browser-logger.ts`; ships to the same central timeline as server-side logs, no new endpoint needed). A collision with another **currently-registered surface agent** (different window) is handled locally and non-fatally: append a short `windowId`-derived suffix and proceed (no log needed — this is expected, handled behavior, not a failure).
  - `unregisterSurfaceAgent(windowId)`, `getActiveSurfaceAgents()`, `onSurfaceAgentsChanged` — same change-notification pattern as `surface-tools.ts:34-44`.
- [X] T039 In `src/lib/assistant/run-manager.ts`: add a `Run`-scoped `agents: Map<string, SurfaceAgentEntry>` field (parallels `run.tools`) and `addSurfaceAgents(run, agents)` (parallels `addSurfaceTools`) — additive-only, mirroring `addSurfaceTools`'s existing "never overwrite/never remove mid-run" behavior exactly (verified this is ALREADY how surface tools behave today, not a new limitation for agents).
- [X] T040 In `src/lib/assistant/start-run.ts`: snapshot `getActiveSurfaceAgents()` at run start (parallels the existing `manager.addSurfaceTools(run, opts.surfaceTools ?? [])` call). Add the **backstop-only** server-side persisted-id collision recheck here (via `listSubAgents()`) — this exists ONLY for the create-after-register race T038's client-side check cannot see; on collision, call `logger().warn("assistant.surface-agents", "surface agent dropped at run start: persisted-id collision", { runId: run.id, conversationId: opts.conversationId, windowId, id })` and drop the entry from `run.agents` rather than crashing run startup.
- [X] T041 Create `src/app/api/assistant/runs/[runId]/surface-agents/route.ts`: `POST { agents }` → `runManager().get(runId)` → `manager.addSurfaceAgents(run, agents)`, modeled 1:1 on the existing `.../surface-tools/route.ts`.
- [X] T042 In `src/lib/assistant/client/run-client.ts`: add `pushSurfaceAgents(runId, agents)` + `flushSurfaceAgents(runId)` (mirroring `pushSurfaceTools`/`flushSurfaceTools`) and subscribe to `onSurfaceAgentsChanged` the same way `onSurfaceToolsChanged` is already subscribed — this is FR-010's "live-pushed mid-run" requirement (plan-review C4; the original plan draft omitted this wiring).
- [X] T043 In `src/lib/assistant/tools/server/discovery.ts` and `subagents.ts`: thread the calling run's `run.agents` into `find_agent`/`agent_list` (today `discoveryTools()`/`subAgentTools()` don't receive the `Run` at all — this is the one genuinely new parameter threaded through `registry.ts`'s composition; make sure the `Run`-specific data is read per-call from `ctx`, NOT baked into `assistantTools()`'s process-wide cache). Merge `listSubAgents()` (persisted) with `run.agents` (surface), tag each result `scope: "persisted" | "surface"`, and score surface agents' `description` the same way `scoreAgent()` scores persisted ones.
- [X] T044 In `agent_delegate`'s resolution: check the persisted roster (`getAgent`) BEFORE the run's surface-agent map — a named agent id always wins if both somehow exist.
- [X] T045 Register UI Preview's surface agent in `src/apps/ui-preview/`'s mounted component: `{name: "Generative UI Agent", description: "Specialist in rendering and iterating on live A2UI mockups in this UI Preview window.", systemPrompt: "...", toolNames: ["a2ui_render", "ui_preview_render"]}` — keep this `systemPrompt` distinct from `a2ui_render`'s own internal sub-agent prompt (the full A2UI catalog dump).
- [X] T046 `npx tsc --noEmit` and `npm run lint`.
- [X] T047 [P] Create `e2e/025-surface-agents.spec.ts` (Playwright, browser-fixture, mirrors `e2e/013-ui-preview.spec.ts`). **"surface-agent full lifecycle" (Example 2, US-4, SC-003, SC-004)**: open Assistant, script `ui_preview_open` first (mounts UI Preview, which registers its surface agent per T045), then in a follow-up scripted turn call `find_agent({query:"generate a UI mockup"})` and assert the response includes `id:"generative-ui-agent"`, `scope:"surface"`; then script `agent_delegate({agent:"generative-ui-agent", task:"@@e2e {...}"})` whose nested script calls `a2ui_render`+`ui_preview_render`, and assert the UI Preview window (`getByTestId("window-ui-preview")`) updates (no longer showing the "Waiting for the agent to render a design" placeholder). Then close the UI Preview window (`getByTestId("window-ui-preview")`'s close control) and, in a NEW scripted message, call `agent_delegate({agent:"generative-ui-agent", task:"..."})` again; assert the `tool_result` contains a clear "no such agent"-style error, not a hang.
- [X] T048 **Unit test, NOT e2e** (`src/lib/assistant/client/__tests__/surface-agents.test.ts`, hand-run convention per T006/T018) — **downgraded from e2e deliberately**: `src/apps/ui-preview/manifest.ts:9` sets `singleton: true`, so two real UI Preview windows can never coexist in the running app; Example 7 / US-4 acceptance scenario 4 (two windows of the SAME app registering a surface agent with the same `name`) is therefore untestable as a true browser e2e test for this specific app. Instead, call `registerSurfaceAgent` directly twice with two different `windowId`s but the same `name` (bypassing the OS-level singleton, which is fine — the behavior under test is the client registry's own id-disambiguation logic, not window management); assert both remain in `getActiveSurfaceAgents()` with distinct, `windowId`-derived-suffix ids (SC-009). In the same file, assert that registering a surface agent named `"assistant"` (colliding with the persisted default agent id, via a stubbed/mocked `fetch("/api/subagents")` response) is REJECTED and never added to the registry, and that `clog()` (T038) is called with the expected `assistant.surface-agents` warn record.
- [X] T049 In `e2e/025-surface-agents.spec.ts` (sequential with T047, same file — NOT `[P]`), add: **"no cross-call memory" (US-5, SC-006)**: with UI Preview already open and a mockup already rendered (state carried over from T047's test, or set up fresh in this test), delegate to `generative-ui-agent` a SECOND time with a scripted task string that explicitly describes the current mockup state in its own text (mirroring Example 3's pattern: the delegating agent, not the delegate, supplies continuity) and asks for a change; assert the second delegation succeeds correctly using only what its own task string said — there is no assertion possible (or needed) that the delegate "forgot" anything, since it never received a transcript in the first place; the test is really confirming the mechanism (blank-slate `task`-only seeding) didn't regress, not probing the delegate's internal state.

**Checkpoint**: All 5 user stories are independently verifiable. Delegation is unified end-to-end: named, ephemeral, and surface agents all resolve through the one registry, execute as inner loops, and collapse to one transcript entry.

---

## Phase 6: Polish & Verify

- [X] T050 [P] `npx tsc --noEmit` and `npm run lint` across the WHOLE branch (not just the last-touched files).
- [X] T051 [P] Run the complete e2e suite (existing + all new tests from Phases 2–5).
- [X] T052 Timeout/linked-abort regression test (plan Risk 3, closes plan-review P1 end-to-end): a delegation whose inner loop legitimately exceeds `toolTimeoutMs` actually STOPS (no further tool calls, no further `ctx.onEvent`) rather than continuing detached after the parent already reported a timeout error.
- [X] T053 **Logging verification (SC-010, FR-027)**: trigger each of the five logged events end-to-end and confirm each is queryable in Settings → Logs, filterable by its `component` and by `conversation`: (1) a delegation start/finish pair (`assistant.delegate`), (2) a depth-guard rejection (`assistant.delegate`), (3) a named agent with an unresolved tool id (`assistant.agents`), (4) a surface-agent registration collision, both the client-side rejection and the server-side backstop (`assistant.surface-agents`), (5) a server-tool idle-timeout (`assistant.tools`). Confirm NONE of these records contain a full `task` string or tool arguments/results — metadata only, per FR-027.
- [X] T054 Update `docs/dev/architecture-overview.md` (and any other doc referencing the old dual-engine delegation model, e.g. `docs/plans/2026-07-11-assistant-v2-server-runs.md` if it describes delegation) to reflect the unified engine.
- [X] T055 Update `specs/bos-system-specs/discrepancies.md` if this closes or introduces any drift from `000-browseros-core`.
- [ ] T056 **Follow-up, not blocking**: per this spec's stated intent ("once implemented and tested, fold this spec's content into `016` and retire this file"), once T050–T055 are all green, merge `025-agent-delegation-v2/spec.md`'s content into `016-unified-agents/spec.md` and retire the `025` spec directory. Requires explicit user sign-off before touching `016` (per the standing rule that `016` was to be left untouched until this point) — do not do this automatically as part of the same pass as T050–T055.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies.
- **Phase 2 (Foundational primitives)**: Depends on Phase 1. BLOCKS Phases 3, 4, 5 — nothing else can be correctly implemented without `inner-loop.ts`/`delegation-gate.ts`/the linked-abort fix existing first.
- **Phase 3 (US-1/2/3 — rewire `agent_delegate`/`dev_delegate`)**: Depends on Phase 2. This is the actual bug fix; do not skip ahead to Phase 4 before this is verified working (T025), so there's never a window where delegation has no working implementation.
- **Phase 4 (retire legacy engine)**: Depends on Phase 3 being verified (T025, T028). Nothing in Phase 3 depends on Phase 4 — the legacy engine can sit unused for a while if needed, though it shouldn't sit unused for long (it's dead weight and a source of confusion).
- **Phase 5 (US-4/5 — surface agents)**: Depends on Phases 2–4 all being solid. A surface agent is "just another delegation target" once the inner loop exists, but its discovery-merge work (T043) specifically depends on Phase 4's registry being the only one (no point threading `run.agents` through a `find_agent` that's about to be deleted and rebuilt).
- **Phase 6 (Polish)**: Depends on all of Phases 1–5.

### Within Each Phase

- Type/interface additions before the logic that uses them (e.g. T003 before T004; T012 before T020).
- `tsc`/`lint` checkpoint at the end of every phase — don't carry type errors forward into the next phase.
- Tests for a phase's new behavior come right after that behavior is implemented, not deferred to Phase 6 (Phase 6's testing tasks are regression/full-suite passes plus the cross-cutting logging verification, T053 — not first-time coverage).
- A logging call (T005's/T017's/T022's/T038's/T040's) is added in the SAME task as the behavior it observes, not as a separate follow-up task — it's a one-line addition to code already being written, not independent work.

### Parallel Opportunities

- T006, T008, T009, T011 (Phase 2) touch independent files/concerns and can be done in parallel once T003–T005/T007 land.
- Phase 3 tests: T026 (creates `e2e/025-agent-delegation.spec.ts`) is `[P]` relative to T028 (a different file, `e2e/025-nested-progress.spec.ts`) once T020–T023 land — but T027/T029 are sequential appends to T026's SAME file, not parallel with it or each other.
- Phase 5 tests: T047 (creates `e2e/025-surface-agents.spec.ts`) and T048 (a different file, the unit test) are `[P]` with each other once T038–T045 land — but T049 is a sequential append to T047's file, not parallel with it.
- T050/T051 (Phase 6) are independent passes and can run in parallel.

## Implementation Strategy

### MVP First

1. Complete Phase 1 (Setup) + Phase 2 (Foundational primitives).
2. Complete Phase 3 (US-1/2/3) — **this alone fixes the motivating bug** (the default "assistant" agent's UI Preview trajectory) and is independently demonstrable even with the legacy engine still physically present in the repo.
3. **STOP and validate**: run T025's manual verification against the original failing trajectory before proceeding.
4. Complete Phase 4 (retire legacy engine) — removes the dual-engine confusion permanently.
5. Complete Phase 5 (US-4/5, surface agents) — the second motivating use case (UI Preview's "Generative UI Agent").
6. Complete Phase 6 (polish + merge-back follow-up).

### Suggested Developer Brief

"Implement Phases 1–5 of `specs/bos-system-specs/025-agent-delegation-v2/plan.md` in strict order — Phase 2 blocks everything else, and Phase 4 (deleting the legacy engine) must not start until Phase 3 is verified working end-to-end. Run `npx tsc --noEmit` and `npm run lint` after every phase and fix all errors before moving on. Pay special attention to T005's linked-abort fix in `runServerTool` (`agent-loop.ts`) — it's a small change to a shared file used by every server tool, not just delegation, so verify non-delegation tools are unaffected (T006). Every new failure path (depth guard, tool-id validation, surface-agent collision, tool timeout) needs both its existing in-band error/UI surfacing AND a `logger()`/`clog()` call per FR-027 — these are called out inline in each relevant task, use BOS's existing central logging service (`@/lib/logging`), never a new mechanism, and never log the full `task` string or tool arguments/results. Do not touch `016-unified-agents/spec.md` — that only happens at T056, after everything else is green and with explicit user sign-off."
