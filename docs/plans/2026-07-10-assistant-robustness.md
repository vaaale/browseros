# Assistant App Robustness Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use claude-superskills:executing-plans to implement this plan task-by-task.

**Goal:** Make the Assistant app rock solid — no hung runs, no lost conversations, agent-visible tool errors — plus HTML code-block viewing, without a rewrite.

**Architecture:** Refactor in place around three pillars: (1) a tool-execution kernel that guarantees every `useCopilotAction` handler settles and returns in-band, model-readable errors with a user-configurable timeout; (2) single-writer conversation persistence with stale-write guards; (3) a consolidated run-lifecycle module that owns all CopilotKit-version-specific compensation (recovery remount, seeding, activity, retry). The long-term "server-resident agent loop, browser as UI-tool executor" direction is captured as a spec, not implemented here — everything in this plan is forward-compatible with it (the kernel becomes the browser-side tool executor).

**Tech Stack:** Next.js App Router, React 19, CopilotKit 1.61 (react-core/react-ui/runtime), Playwright e2e (no unit runner — pure-module tests run as browser-less Playwright specs), TypeScript.

**Working rules (from CLAUDE.md + user workflow):**
- Branch: `bos/assistant-robustness` (Phase 5 may use `bos/chat-html-view` if split out).
- After every task: `npx tsc --noEmit && npm run lint` must pass.
- **The user owns commits and manual UI testing.** Commit steps below mean: stage, propose the commit message, and STOP for the user to manually test in the browser and commit (or explicitly approve committing). Never auto-commit. Uncommitted work in this checkout is fragile (Supervisor can reset it), so reach commit checkpoints promptly.
- Do not run `npm run build` while `next dev` is running.
- Preserve working UI: integrate alongside what exists; never strip working behavior while adding features.

**Key review findings this plan fixes (file:line refs as of 2026-07-10):**
- Only WebSearch has a timeout (`postJsonWithTimeout`, 110 s, `src/components/agent/WebSearchActions.tsx`); 15 of 18 action files use raw `fetch`. One hung handler freezes the entire run because CopilotKit executes tool calls sequentially.
- Unbounded NDJSON `reader.read()` loops: `SubAgentActions.tsx:245-247` (`agent_delegate`), `WorkflowActions.tsx:81-83` (`workflow_run`).
- `app_uninstall` in `DevActions.tsx` has a bare fetch with no error handling; error shapes are inconsistent across files.
- `saveConversationMessages` (`src/lib/agent/conversations.ts:344-360`) is read-modify-write with no lock/version guard; writers: 400 ms debounced save, RUN_ERROR flush, rename/agent-change/branch-change, second mounted surface.
- Run-lifecycle state machine smeared across `CopilotProvider.tsx` (recoveryGen 72-81, console.error patch 35-48), `ChatPersistence.tsx` (seed refs 34-44, abort-on-switch 60-70), `AgentActivityIndicator.tsx` (pending heuristic 23-38), `ToolCallRetry.tsx` (isLoading edge 36-44).
- Syntax highlighting already works (`MarkdownRenderers.tsx`, Prism + oneDark); `html-viewer` app exists (`src/apps/html-viewer/index.tsx`, accepts `params.html`/`params.url`, sandboxed) but is not wired to chat code blocks.

---

## Phase 0 — Groundwork

### Task 0.1: Create the feature branch

**Step 1:** `git checkout -b bos/assistant-robustness`
Expected: on new branch, clean tree.

### Task 0.2: CopilotKit changelog investigation (decision point)

**Files:** none (research only; findings appended to this plan under "Findings").

**Step 1:** Check CopilotKit releases after 1.61.2 (GitHub releases / npm) for: (a) RUN_ERROR / poisoned-agent recovery fixes, (b) parallel or bounded client tool execution in `processAgentResult`, (c) AG-UI remote-agent improvements relevant to the future server-resident loop.

**Step 2:** Append a dated "Findings" section to this plan file. If a newer minor fixes (a), Phase 4 shrinks (recovery remount may become unnecessary) — flag it, do NOT upgrade the dependency in this plan (lockfile changes need explicit user approval per CLAUDE.md).

---

## Phase 1 — Configurable tool-call timeout setting

### Task 1.1: Add `toolCallTimeoutSec` to the `tools` config namespace

**Files:**
- Modify: `src/lib/config/registry.ts` (the `tools` entry, currently lines 67-97)

**Step 1:** Add a clamp helper next to `clampMaxFindResults` (top of file):

```ts
// Clamps tools.toolCallTimeoutSec into 10..3600 (default 600).
const TOOL_TIMEOUT_DEFAULT = 600;
function clampToolTimeout(n: number): number {
  if (!Number.isFinite(n)) return TOOL_TIMEOUT_DEFAULT;
  return Math.min(3600, Math.max(10, Math.round(n)));
}
```

**Step 2:** In the `tools` schema `fields` array, add:

```ts
{
  key: "toolCallTimeoutSec",
  label: "Tool call timeout (seconds)",
  type: "number",
  description:
    "Max time a single assistant tool call may run before it is aborted and reported to the agent as an error. Streaming tools (agent_delegate, workflow_run) treat this as an idle timeout instead. 10–3600, default 600.",
},
```

**Step 3:** Extend `load` to return `toolCallTimeoutSec: clampToolTimeout(typeof s.toolCallTimeoutSec === "number" ? s.toolCallTimeoutSec : TOOL_TIMEOUT_DEFAULT)` and `save` to clamp it (mirror the `maxFindResults` handling at lines 90-95 exactly).

**Step 4:** Run: `npx tsc --noEmit && npm run lint` → Expected: clean.

### Task 1.2: Surface the setting in Settings → Tools

**Files:**
- Modify: `src/components/apps/settings/ToolsTab.tsx`

**Step 1:** Mirror the existing `maxFindResults` pattern exactly (state at line 46, load at line 59, save POST at line 76, input at line 132): add `toolCallTimeoutSec` state (default 600), load it from `tools?.values?.toolCallTimeoutSec`, save via the same `/api/config` POST (`{ namespace: "tools", values: { toolCallTimeoutSec } }`), and render a number input labeled "Tool call timeout (s)" beside the discovery-results input. Reuse the tab's existing auto-save/`AutoSaveStatus` affordances — do not invent a new form style.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

**Step 3 (manual, user):** Settings → Tools shows the field; changing it persists across reload (`data/config.json` or namespace store gets the value).

### Task 1.3: Client-side accessor for the timeout

**Files:**
- Create: `src/lib/agent/tool-kernel.ts` (started here; grown in Phase 2)

**Step 1:** Create the accessor — module-level cache, refreshed lazily and on the existing settings event (same event `CopilotProvider.tsx:111-113` already listens to):

```ts
// Framework-free tool-execution kernel (client-side). No "use client" needed:
// pure functions + fetch; imported by the *Actions.tsx components.

const TIMEOUT_DEFAULT_MS = 600_000;
const TIMEOUT_REFRESH_MS = 30_000;

let cachedTimeoutMs = TIMEOUT_DEFAULT_MS;
let cachedAt = 0;
let refreshInFlight: Promise<void> | null = null;

async function refreshTimeout(): Promise<void> {
  try {
    const r = await fetch("/api/config?namespace=tools");
    const j = await r.json();
    const sec = j?.values?.toolCallTimeoutSec ?? j?.tools?.values?.toolCallTimeoutSec;
    if (typeof sec === "number" && Number.isFinite(sec)) {
      cachedTimeoutMs = Math.min(3600, Math.max(10, Math.round(sec))) * 1000;
    }
  } catch { /* keep previous value */ }
  cachedAt = Date.now();
}

export function getToolTimeoutMs(): number {
  if (Date.now() - cachedAt > TIMEOUT_REFRESH_MS && !refreshInFlight) {
    refreshInFlight = refreshTimeout().finally(() => { refreshInFlight = null; });
  }
  return cachedTimeoutMs;
}

if (typeof window !== "undefined") {
  window.addEventListener("bos:agent-updated", () => { cachedAt = 0; });
}
```

> NOTE for executor: verify the exact GET shape of `/api/config` (`src/app/api/config/route.ts`) and the exact settings-changed event name before wiring — `ToolsTab.tsx` and `CopilotProvider.tsx` are the references. Adjust the accessor to match reality, not the sketch.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

**Step 3: Commit checkpoint (user).** Proposed message: `Settings → Tools: configurable tool call timeout (default 600s)`.

---

## Phase 2 — Tool-execution kernel

**Contract (user requirement, non-negotiable):** a handler never throws and never hangs. It always settles and returns a string. On failure the string is a structured, model-readable error (`Error: <tool>: <what failed> — <hint>`), so the agent is notified in-band and can react. Timeouts use the Phase 1 setting: total duration for request/response tools, idle (silence) duration for streaming tools. Run-level failure stays reserved for transport errors outside handlers.

### Task 2.1: Kernel core + failing test

**Files:**
- Modify: `src/lib/agent/tool-kernel.ts`
- Test: `e2e/tool-kernel.spec.ts` (browser-less Playwright spec, same style as `card-collapse.spec.ts` pure-module parts)

**Step 1: Write the failing test** (no `page` fixture — pure Node):

```ts
import { test, expect } from "@playwright/test";
import { runToolHandler, toolError } from "../src/lib/agent/tool-kernel";

test.describe("tool kernel", () => {
  test("returns handler result on success", async () => {
    const r = await runToolHandler("demo", async () => "ok", { timeoutMs: 1000 });
    expect(r).toBe("ok");
  });

  test("converts a thrown error into an in-band Error string", async () => {
    const r = await runToolHandler("demo", async () => { throw new Error("boom"); }, { timeoutMs: 1000 });
    expect(r).toMatch(/^Error: demo: boom/);
  });

  test("times out a hung handler and reports it to the agent", async () => {
    const r = await runToolHandler("demo", () => new Promise<string>(() => {}), { timeoutMs: 100 });
    expect(r).toMatch(/^Error: demo: timed out after/);
  });

  test("non-string results are JSON-stringified", async () => {
    const r = await runToolHandler("demo", async () => ({ a: 1 } as unknown as string), { timeoutMs: 1000 });
    expect(r).toBe('{"a":1}');
  });
});
```

**Step 2:** Run: `npx playwright test e2e/tool-kernel.spec.ts` → Expected: FAIL (module/functions missing).

**Step 3: Implement** in `tool-kernel.ts`:

```ts
export function toolError(tool: string, detail: string, hint?: string): string {
  return `Error: ${tool}: ${detail}${hint ? ` — ${hint}` : ""}`;
}

export interface RunToolOpts {
  /** Override; defaults to the configured Settings → Tools value. */
  timeoutMs?: number;
  /** Extra hint appended to timeout errors (e.g. "the sub-agent may still be running"). */
  timeoutHint?: string;
  /** AbortController handed to the handler for fetch cancellation. */
  signal?: never; // handler receives its own controller — see fn signature
}

export async function runToolHandler(
  tool: string,
  fn: (ctx: { signal: AbortSignal }) => Promise<unknown>,
  opts: RunToolOpts = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? getToolTimeoutMs();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const result = await Promise.race([
      fn({ signal: ctl.signal }),
      new Promise<never>((_, rej) => {
        ctl.signal.addEventListener("abort", () =>
          rej(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s${opts.timeoutHint ? ` — ${opts.timeoutHint}` : ""}`)),
        );
      }),
    ]);
    if (typeof result === "string") return result;
    if (result === undefined || result === null) return "ok";
    try { return JSON.stringify(result); } catch { return String(result); }
  } catch (e) {
    return toolError(tool, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
```

Also add the two fetch helpers every converted handler will use:

```ts
/** JSON request/response with the configured timeout. Never throws. */
export async function fetchToolJson(
  tool: string,
  input: RequestInfo,
  init?: RequestInit,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> { /* fetch with signal, non-OK → error string incl. status + body detail, invalid JSON → error string */ }

/** NDJSON stream consumer with an IDLE timeout: aborts only after `idleMs` of silence. */
export async function readNdjsonStream(
  tool: string,
  res: Response,
  onLine: (line: string) => void,
  idleMs: number,
  idleHint: string,
): Promise<{ ok: true } | { ok: false; error: string }> { /* reader.read() loop; reset a deadline timer on every chunk; on idle-abort return toolError(tool, `stream idle for ${..}s`, idleHint) */ }
```

(Executor: implement these fully — complete bodies, no TODOs. `readNdjsonStream` owns the `getReader()`/`TextDecoder`/line-splitting logic currently duplicated in `SubAgentActions.tsx:242-260` and `WorkflowActions.tsx:77-95`.)

**Step 4:** `npx playwright test e2e/tool-kernel.spec.ts` → Expected: PASS. Then `npx tsc --noEmit && npm run lint` → clean.

**Step 5: Commit checkpoint (user).** `Tool-execution kernel: guaranteed-settle handlers with configurable timeout`.

### Task 2.2: Convert WebSearchActions (reference conversion)

**Files:**
- Modify: `src/components/agent/WebSearchActions.tsx`
- Modify: `src/lib/agent/web-search.ts` (server: derive SDK timeout from the setting)

**Step 1:** Replace `postJsonWithTimeout` (hardcoded 110 s) with `runToolHandler` + `fetchToolJson`. Conversion pattern to replicate everywhere:

```ts
// BEFORE
handler: async ({ query }) => {
  const res = await fetch("/api/x", { ... }).then((r) => r.json());
  return res.error ? `Error: ${res.error}` : JSON.stringify(res.data);
},

// AFTER
handler: ({ query }) =>
  runToolHandler("web_search", async ({ signal }) => {
    const r = await fetchToolJson("web_search", "/api/x", { method: "POST", body: JSON.stringify({ query }), headers: { "Content-Type": "application/json" }, signal });
    if (!r.ok) return r.error;
    return JSON.stringify(r.data);
  }),
```

**Step 2:** In `web-search.ts`, replace the hardcoded `{ timeout: 90_000 }` SDK option with a value derived from the configured timeout (read the `tools` namespace server-side; use `Math.max(30_000, configuredMs - 20_000)` so the server gives up before the client does).

**Step 3:** `npx tsc --noEmit && npm run lint` → clean.

**Step 4 (manual, user):** run a web search in chat; then set timeout to 10 s in Settings and point at an unreachable provider → the chat shows a tool error result and the agent responds to it (run does NOT freeze).

### Task 2.3: Convert the simple-fetch action files (batch)

**Files (modify each):** `ConfigActions.tsx`, `DocsActions.tsx`, `GitActions.tsx`, `RunCommandActions.tsx`, `SkillsActions.tsx`, `SpecActions.tsx`, `SelfImprovementActions.tsx`, `DiscoveryActions.tsx`, `MemoryActions.tsx`, `WorkflowActions.tsx` (all handlers EXCEPT `workflow_run`), `DevActions.tsx`, `McpActions.tsx`, `SubAgentActions.tsx` (`agent_list`/`agent_create` only).

**Step 1:** Apply the Task 2.2 pattern to every handler. Specific known fixes while there:
- `DevActions.tsx` `app_uninstall`: currently a bare fetch with no error handling — wrap like the rest.
- Multi-fetch handlers (`spec_edit` 2× fetch, `memory_save` 2× fetch): the whole handler runs inside ONE `runToolHandler` so the timeout covers the chain; pass `signal` to every fetch.
- Keep each tool's name string in the `runToolHandler(name, …)` call identical to the action `name:` so errors identify the tool for the model.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

**Step 3 (manual, user):** exercise a few converted tools in chat (e.g. `skills_list`, `docs_read`, `config_list`).

**Step 4: Commit checkpoint (user).** `Convert simple tool handlers to the kernel (timeouts + in-band errors)`.

### Task 2.4: Convert local/non-fetch handlers

**Files:**
- Modify: `OSActions.tsx` (fsClient calls + sync handlers), `ScratchpadActions.tsx`, `IntegrationActions.tsx`

**Step 1:** Wrap every handler in `runToolHandler` even when synchronous/local (uniform contract; cost is nil). For `OSActions` fsClient calls and `IntegrationActions.invokeAdapterMethod`, the kernel timeout now bounds them regardless of what those helpers do internally — no changes needed inside `fsClient` itself. Preserve `IntegrationActions`' existing error-code mapping (scope_disabled / auth_failed / config_invalid) — those strings are model-facing and must survive, just routed through the kernel.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

### Task 2.5: Convert the two streaming handlers (idle timeout)

**Files:**
- Modify: `SubAgentActions.tsx` (`agent_delegate`, lines ~222-280), `WorkflowActions.tsx` (`workflow_run`, lines ~63-105)

**Step 1:** Replace both hand-rolled `reader.read()` loops with `readNdjsonStream`, inside `runToolHandler` with a LONG outer budget:
- Outer `runToolHandler` timeout: `getToolTimeoutMs() * 6` (a healthy delegation may run far beyond one idle window; the outer cap is a last-resort backstop).
- Inner `readNdjsonStream` idleMs: `getToolTimeoutMs()` (the configured 600 s default = max silence).
- Idle hints (must be truthful, per requirement): `agent_delegate` → `"the delegation stream went silent and was abandoned client-side; the sub-agent may still be running — check its status before re-delegating"`; `workflow_run` → `"the workflow stream went silent; the workflow may still be executing — use workflow_status before re-running"`.
- Keep the existing per-line event handling (delegation progress rendering via `startDelegation`/`finishDelegation`, event tree accumulation) byte-for-byte — only the transport loop changes. Ensure `finishDelegation` is called on EVERY exit path (success, error, idle-abort) so the UI never shows a stuck delegation card.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

**Step 3 (manual, user):** run an `agent_delegate` task end-to-end; verify live progress still renders and completion returns the result.

**Step 4: Commit checkpoint (user).** `Streaming tool handlers: idle timeouts + truthful abandonment errors`.

### Task 2.6: Hung-tool regression e2e

**Files:**
- Test: `e2e/tool-timeout.spec.ts`

**Step 1:** Write a spec that (a) sets `toolCallTimeoutSec` to 10 via `POST /api/config`, (b) opens a conversation whose next turn triggers a tool call against a stalling endpoint (add a dev-only test route or use Playwright route interception to hang `/api/docs`), (c) asserts that within ~15 s the chat shows a tool result matching `/Error: .*timed out/` and the run completes (input re-enabled) rather than freezing. Follow `no-uncommanded-run.spec.ts` for the conversation-seeding recipe (write `/Documents/Chats/<id>.json` via `POST /api/fs`, set `localStorage bos.activeConversation.<agentId>`).

**Step 2:** Run: `npx playwright test e2e/tool-timeout.spec.ts` → Expected: PASS.

**Step 3: Commit checkpoint (user).** `e2e: hung tool call surfaces as in-band error, run never freezes`.

---

## Phase 3 — Single-writer conversation persistence

### Task 3.1: Verify/ensure atomic VFS writes

**Files:**
- Inspect: `src/os/vfs.ts`, `src/app/api/fs/route.ts` (or wherever `fsClient.write` lands)
- Possibly modify: the server write path

**Step 1:** Read the server write implementation. If it writes files directly (`fs.writeFile` to the final path), change to temp-file + `fs.rename` in the same directory (the compaction sidecar's `writeFileAtomic` in `src/lib/agent/compaction/sidecar.ts:82-85` is the in-repo reference — reuse or extract it). If it is already atomic, record that in the plan Findings and skip.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

### Task 3.2: Per-conversation write queue + stale-write guard

**Files:**
- Modify: `src/lib/agent/conversations.ts`
- Test: `e2e/conversations-writer.spec.ts` (pure-module spec)

**Step 1: Write the failing test** — pure-module spec importing from `conversations.ts` is awkward (it touches `localStorage`/`fsClient`), so extract the queue as a pure helper first: create `enqueuePerKey(key, task)` in `src/lib/agent/write-queue.ts` (framework-free):

```ts
import { test, expect } from "@playwright/test";
import { enqueuePerKey } from "../src/lib/agent/write-queue";

test("writes to the same key are serialized in order", async () => {
  const order: number[] = [];
  const slow = enqueuePerKey("a", async () => { await new Promise((r) => setTimeout(r, 50)); order.push(1); });
  const fast = enqueuePerKey("a", async () => { order.push(2); });
  await Promise.all([slow, fast]);
  expect(order).toEqual([1, 2]);
});

test("different keys run concurrently", async () => {
  let aDone = false;
  const a = enqueuePerKey("a", async () => { await new Promise((r) => setTimeout(r, 50)); aDone = true; });
  const b = enqueuePerKey("b", async () => { expect(aDone).toBe(false); });
  await Promise.all([a, b]);
});
```

**Step 2:** `npx playwright test e2e/conversations-writer.spec.ts` → FAIL (module missing).

**Step 3: Implement** `write-queue.ts` (map of key → promise chain; entries cleaned up when the chain drains; a failed task must not poison the chain — catch and continue).

**Step 4:** Route ALL file writers in `conversations.ts` through it, keyed by conversation id: `writeConversationFile`, and therefore `saveConversationMessages`, `renameConversation`, `setConversationAgent`, `setConversationActiveFeatureBranch`, `newConversation`, plus the RUN_ERROR flush path (it calls `saveConversationMessages`, so it inherits the queue). Move the read-modify-write INSIDE the queued task so read and write are one critical section.

**Step 5: Stale-write guard** in `saveConversationMessages`: keep the existing empty-snapshot guard (line 348) and add a monotonic rule — inside the queued task, after reading `existing`, skip the write when the incoming snapshot is a strict prefix-regression: `messages.length < existing.messages.length` AND every incoming message id exists in `existing.messages` (a debounced stale snapshot). A legitimately shortened history (regenerate/edit) changes the tail ids, so it still writes. Log a `console.warn("[BOS] skipped stale conversation write", …)` when skipping.

**Step 6:** `npx playwright test e2e/conversations-writer.spec.ts` → PASS; `npx tsc --noEmit && npm run lint` → clean.

**Step 7 (manual, user):** rapid conversation switching while the agent streams; rename a conversation mid-stream; verify no history loss and titles stick.

**Step 8: Commit checkpoint (user).** `Single-writer conversation persistence with stale-write guard`.

---

## Phase 4 — Run-lifecycle consolidation (`useAssistantRuntime`)

**Constraint:** behavior-preserving refactor. Every compensation currently working stays working; the win is one owner, explicit states, and testability. Browser-test before claiming done.

### Task 4.1: Extract the lifecycle module

**Files:**
- Create: `src/components/agent/assistant-runtime.ts`
- Modify: `CopilotProvider.tsx`, `ChatPersistence.tsx`, `AgentActivityIndicator.tsx`, `ToolCallRetry.tsx`

**Step 1:** Create `useAssistantRuntime(agentId, threadId)` exposing an explicit machine:

```ts
export type RunPhase = "idle" | "running" | "tool-exec" | "errored" | "recovering";
export interface AssistantRuntime {
  phase: RunPhase;
  /** Monotonic key component; bumping remounts the CopilotKit provider (RUN_ERROR recovery). */
  recoveryGen: number;
  /** True while any tool call awaits its result (drives the activity pill). */
  pendingToolCall: boolean;
  /** Rising/falling isLoading edges, exposed so consumers stop re-deriving them. */
  onGenerationFinished(cb: (lastAssistantMessageId: string) => void): () => void;
  stop(): void;
}
```

Move into it, verbatim in behavior:
- RUN_ERROR subscription + debounced flush-then-remount (`CopilotProvider.tsx:74-81, 163-202`) → drives `phase: "errored" → "recovering"` and `recoveryGen`.
- Pending-tool-call derivation (`AgentActivityIndicator.tsx:23-38`) → `pendingToolCall` (single subscription instead of per-component).
- isLoading edge detection (`ToolCallRetry.tsx:36-44`) → `onGenerationFinished` (also consumed by Phase 5's auto-open watcher).
- Stop semantics incl. the post-stop suppression (`AgentActivityIndicator.tsx:58-66`) → `stop()` + phase transition.

Keep in place (correct locations already): sanitize/normalize pure helpers; ChatPersistence's seeding — but ChatPersistence should read agent/thread identity via the runtime so the dual-key seeding rationale lives in ONE documented spot.

**Step 2:** Convert the four consumers to thin users of the hook. Delete the now-redundant local refs/effects. The global `console.error` monkey-patch (`CopilotProvider.tsx:35-48`) moves into `assistant-runtime.ts` unchanged (still ugly, now at least owned; removing it is out of scope).

**Step 3:** `npx tsc --noEmit && npm run lint` → clean. Run full e2e: `npx playwright test` → all existing specs (esp. `no-uncommanded-run`, `card-collapse`, `per-agent-*`) PASS.

**Step 4 (manual, user — the critical gate):** open Assistant → history loads; switch conversations rapidly; force a provider error mid-run (wrong base URL) → recovery keeps history and chat stays usable; Stop works during a tool call; delegation progress renders.

**Step 5: Commit checkpoint (user).** `Consolidate run lifecycle into useAssistantRuntime (behavior-preserving)`.

### Task 4.2: Lifecycle regression e2e

**Files:**
- Test: `e2e/run-recovery.spec.ts`

**Step 1:** Spec: seed a conversation, point the provider at a Playwright-intercepted `/api/copilotkit` that returns a broken stream once then works; send a message; assert the chat recovers (provider remount) with prior history intact and the next message succeeds. Assert the interrupted-turn note behavior on reload matches `sanitizeLoadedMessages` (no uncommanded run — reuse assertions from `no-uncommanded-run.spec.ts`).

**Step 2:** `npx playwright test e2e/run-recovery.spec.ts` → PASS.

---

## Phase 5 — HTML code blocks: View button + auto-open

(Syntax highlighting already exists — Prism/oneDark in `MarkdownRenderers.tsx`. HTML+JS is one document; the sandbox already has `allow-scripts`.)

### Task 5.1: "Open in viewer" button on ```html blocks

**Files:**
- Modify: `src/components/agent/MarkdownRenderers.tsx` (`HtmlBlock`, lines 15-31)

**Step 1:** In `HtmlBlock`, add a button next to the existing "Preview" toggle (keep the inline preview — preserve working UI):

```tsx
import { useOSStore } from "@/store/os-provider";
// inside HtmlBlock:
const launch = useOSStore((s) => s.launch);
// header, next to the Preview button:
<button onClick={() => launch("html-viewer", { html: code, title: "Agent HTML" })}
        className="rounded px-1.5 hover:bg-white/10">
  View
</button>
```

Because renderers run on every displayed message, this works identically for historical conversations — the code IS the persisted conversation, no extra state.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

**Step 3 (manual, user):** open an old conversation containing an ```html block → View opens the HTML Preview window rendering it (JS runs, sandboxed).

### Task 5.2: Auto-open on live generation

**Files:**
- Create: `src/components/agent/HtmlAutoOpen.tsx`
- Modify: `src/components/agent/AssistantChat.tsx` (mount it inside the provider, next to `<ChatToolRenderer />`)

**Step 1:** Watcher component using `useAssistantRuntime().onGenerationFinished` (Phase 4) — or, if Phase 5 is executed before Phase 4, the same isLoading true→false edge pattern as `ToolCallRetry.tsx:36-44`:
- On generation-finished only (NEVER on history load — the edge gating is the established guard, see `ToolCallRetry` header comment), scan the just-finished assistant message for a COMPLETE fenced ```html block (regex: ` ```html\n([\s\S]*?)``` ` and `/<\w/` sanity check, matching `MarkdownRenderers.tsx:101`).
- Track handled message ids in a ref → open once per message.
- Window policy: keep the last auto-opened `windowId` in a ref; if that window is still open (`useOSStore` windows list), `close(prevId)` before `launch("html-viewer", { html, title })` — one live auto-viewer, no window spam. Manual "View" clicks are unaffected.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

**Step 3: e2e** — `e2e/html-view.spec.ts`: (a) seed a historical conversation with an ```html block → assert the View button exists and opening it creates an `html-viewer` window with an iframe whose `srcdoc` contains the marker text; (b) assert that merely LOADING that conversation opens NO viewer window (auto-open must not fire on history).

**Step 4:** `npx playwright test e2e/html-view.spec.ts` → PASS.

**Step 5 (manual, user):** ask the agent for "a small HTML+JS demo page" → on completion the viewer opens automatically with the rendered page.

**Step 6: Commit checkpoint (user).** `Chat HTML blocks: View-in-app button + auto-open on generation`.

### Task 5.3: Agent instruction nudge

**Files:**
- Modify: `src/lib/agent/config.ts` (CORE_POLICY)

**Step 1:** Add one line to the policy: when producing renderable web output, emit ONE self-contained ```html document (inline CSS/JS) rather than separate html/js blocks — separate blocks cannot be auto-rendered.

**Step 2:** `npx tsc --noEmit && npm run lint` → clean.

---

## Phase 6 — Documentation + follow-up spec

### Task 6.1: Developer docs

**Files:**
- Modify: `docs/dev/architecture-overview.md` (assistant section) or the relevant `docs/dev/` page

**Step 1:** Document: the tool-kernel contract (always settle, in-band errors, configured timeout, idle semantics for streaming tools), the write-queue/stale-guard, `useAssistantRuntime` as the single owner of CopilotKit compensations, and the HTML view/auto-open behavior. Update `docs/usage/` for the new Settings → Tools field and the View button.

### Task 6.2: Server-resident agent spec (design only — NOT implemented in this plan)

**Step 1:** Via Build Studio (per project workflow), author a new feature spec in the system store: **server-resident conversation runs** — the loop lives server-side (unifying with the existing `runToolLoop` runtime); the browser is a renderer + frontend-tool executor; frontend tools are dispatched over the stream and executed by the Phase 2 kernel; a detached client yields an in-band `Error: no client attached to execute UI tool`; runs survive tab close with reconnect/resume via a per-run event log. Record explicitly that the Phase 2 kernel and Phase 3 single-writer server ownership are prerequisites it builds on.

**Step 2: Final commit checkpoint (user)** for docs, then merge decision on `bos/assistant-robustness`.

---

## Execution order & dependencies

```
0.1 → 0.2 → Phase 1 → Phase 2 (2.1 → 2.2 → 2.3/2.4 in parallel → 2.5 → 2.6)
                     → Phase 3 (independent of Phase 2; needs 0.1 only)
Phase 4 after Phases 2+3 (its manual gate exercises both)
Phase 5 after 4 preferably (uses onGenerationFinished) — may run earlier with the edge-pattern fallback
Phase 6 last
```

Manual-test + commit gates: end of Phases 1, 2 (twice), 3, 4, 5. The user performs all commits.

---

## Findings

### Task 0.2 — CopilotKit changelog investigation (2026-07-10)

Latest stable: **1.62.3** (2026-07-08). **Verdict: upgrading fixes none of our three workarounds — plan proceeds unchanged on 1.61.2.**

1. **RUN_ERROR poisoning: NOT fixed.** Root cause is in `@ag-ui/client`'s event state machine (ag-ui #1892 — rejects a second terminal event); both 1.61.2 and 1.62.3 pin `@ag-ui/client 0.0.57`. No client-side "reset failed agent" API exists; CopilotKit #5812 (TEXT_MESSAGE_END after RUN_ERROR → chat unusable) is open with unreleased fix PRs. → Phase 4 keeps the recovery-remount mechanism.
2. **Sequential client tool execution: NOT fixed.** No parallel execution or per-tool timeouts in any 1.62.x (#5554 documents no timeout mechanism; #2809 / #5374 show the area still being patched). → the Phase 2 kernel is the correct and only mitigation. NOTE: since 1.61.2 the v2 `useFrontendTool` surface passes an `AbortSignal` to handlers (PR #3515) and Stop rejects pending HITL promises (#5633) — **the kernel should honor an externally supplied signal (Stop button) in addition to its own timeout controller** (added to Task 2.1 scope).
3. **AG-UI remote/server agents:** supported server-resident pattern remains `CopilotRuntime` + `HttpAgent` + `copilotkit.runAgent({agent})` (frontend tools injected only via the high-level entrypoint — #5813 "by design"). 1.62.2 added reconnect hardening + multi-device run-activity sync. Open gaps relevant to the Phase 6 spec: #3531 (connect streams can't follow future runs), #4943 (thread hydration on replay).

Upgrade risk if done later: low (same ag-ui pins); one behavior change in 1.62.0 — unhandled tool calls render nothing instead of a default card.
