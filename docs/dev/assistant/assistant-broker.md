# The assistant broker — driving the assistant from a sandboxed app

*Feature: `040-assistant-broker-capability`. Spec/design: `user-specs/app-infrastructure/040-assistant-broker-capability/`.*

An installed app with `origin: "marketplace"` runs in an iframe sandboxed **without**
`allow-same-origin`, so the browser gives it an opaque origin. A direct
`fetch("/api/assistant/runs")` from inside it is cross-origin against routes that
intentionally set no CORS headers, and fails with a bare `NetworkError` — see
[design-heuristics § "Opaque-origin sandboxed apps can't `fetch()` BOS APIs directly"](../design-heuristics.md).

The fix is never "open CORS". The trusted, same-origin **parent frame** makes the call and
relays the result over the existing `window.__bos` postMessage broker — the pattern
`fs` / `settings` / `services:read` already use. The `assistant` capability is that path
for the assistant run API.

What makes the assistant different from every other broker capability: a run is a
**stream**, and an NDJSON `ReadableStream` cannot cross `postMessage`. So the parent has to
be the stream owner.

---

## The capability

| | |
|---|---|
| Name | `assistant` |
| Grants | start assistant runs, stream their events, answer their frontend tool calls, cancel them |
| Scope | **only runs this app started** (per-app run ownership) |
| Grantable | **declaration-gated** — only if the app's own `app.json` lists `"assistant"` in `capabilities` |
| Storage | `data/system/config/<id>/capabilities.json`, like every other grant |

Declaration-gating (ADR-6) is a deliberate deviation from the sibling capabilities, which
are flat — any app can be given `fs:read` whether or not it asked. Driving the assistant
means reaching the user's conversations, tools and agents, so the app has to opt in before
the user can grant it. Enforced in **two** places:

- `PUT /api/apps/[id]/capabilities` drops `assistant` from the grant set and returns
  `{rejected, warning}` when the manifest is silent — so a direct API call can't bypass
  the UI;
- Settings → Apps renders the `Assistant` checkbox **only** for declaring apps.

Declaration without a grant is the same as no grant: the `IframeApp` capability gate is
unchanged.

---

## The wiring places

Adding a broker method touches the usual four places plus the SDK. This feature's fifth
place is a whole module, because the assistant methods are stateful:

| Place | File | Change |
|---|---|---|
| 1. capability type | `src/os/types.ts` | `"assistant"` in the `AppCapability` union |
| 2. server allowlist | `src/app/api/apps/[id]/capabilities/route.ts` | `"assistant"` in `VALID_CAPS` (**a capability missing here is silently dropped by `PUT` — no error**) + the `DECLARATION_GATED` check |
| 3. grant UI | `src/components/apps/settings/AppsTab.tsx` | the `assistant` row, `requiresDeclaration: true` |
| 4. broker gate + route | `src/components/apps/IframeApp.tsx` | `CAP_FOR_METHOD` entries; `assistant:*` routed to the broker instead of `dispatch()` |
| 5. the broker | `src/components/apps/assistant-broker.ts` | **new** — the per-run stream owner |
| 6. client SDK | `src/lib/iframe-sdk/index.ts` | `window.__bos.assistant.*` + the `__bos_event` listener |

---

## The six methods

All require the `assistant` capability. Each resolves with the equivalent HTTP API's
**response body verbatim**; on an API error the body carries `error` and `status` instead,
so structured detail survives (a 409 from run-start still carries `activeRunId`). This is
what makes an app behave the same through the broker as a direct `fetch` would.

| broker method | params | HTTP call behind it | resolves with |
|---|---|---|---|
| `assistant:list-agents` | `{}` | `GET /api/assistant/agent` | `{agents, catalog}` (relayed whole — ADR-4) |
| `assistant:start-run` | `{conversationId, agentId, message, surfaceTools?, attachments?}` | `POST /api/assistant/runs` | `{runId}`, or `{error, status: 409, activeRunId}` |
| `assistant:events-attach` | `{runId, since}` | `GET .../runs/[runId]/events?since=` (parent-owned) | `{ok, runId, since, finished, expired}` — the **events themselves arrive as pushes** |
| `assistant:tool-result` | `{runId, callId, result}` | `POST .../runs/[runId]/tool-results` | `{claimed}` |
| `assistant:active-run` | `{conversationId}` | `GET /api/assistant/runs?conversationId=` | `{runId, agentId, startedAt, status}` or `{runId: null}` |
| `assistant:cancel-run` | `{runId}` | `POST .../runs/[runId]/cancel` | `{ok, cancelled, status}` |

An ungranted call rejects **synchronously**, before any dispatch, with
`Capability "assistant" not granted`.

There is deliberately **no** mid-run `push-surface-tools` method. Surface tools ride the
`startRun` body into the unchanged `startAssistantRun`, which merges them into `run.tools`
— identical to the direct-HTTP path, which is what makes "exactly as if started over HTTP"
literally true. (The BOS chat needs a mid-run push because every open window
auto-contributes its tools; a sandboxed app declares its own up front.)

---

## Parent-push + bounded buffer

The run's event log already lives server-side: `runManager()` keeps an append-only,
monotonically-sequenced `run.events` array (50 000-event cap, 5-minute post-finish
retention) and `subscribe(run, since, cb)` replays `seq > since` then tails live. The
events route is purely a viewer — *N tabs are N viewers, never N executors*.

So the parent is **just another viewer**. It runs the same reader loop the BOS chat's own
`src/lib/assistant/client/run-client.ts attachToRun` runs, and pushes each parsed event
into the child as an unsolicited message:

```js
{ __bos_event: true, runId, event }   // event = the server's RunEvent, verbatim
```

That push is the **only** non-request/response broker interaction. The other five methods
use the normal correlated `__bos_call` / `__bos_response` channel, so an in-flight stream
never blocks another call (NFR-003) and there is no tied-up long poll.

```
run-manager.ts  ──NDJSON──▶  assistant-broker.ts  ──__bos_event──▶  iframe-sdk  ──▶  app
 (authoritative)             (bounded cache + cursors)              (onRunEvent)
```

Chosen over child-poll (ADR-1) because a poll adds its interval to every event batch and
pushes reconnect/backoff logic into every app, for no gain — both models need the parent to
own the stream anyway.

### Ordering

One tail per run, single-threaded; buffered events replay in `seq` order and live events
append in increasing `seq`; `postMessage` from one source to one iframe is FIFO. So a child
observes strictly increasing `seq` per run. Keepalive `ping` lines carry no `seq` and are
never buffered or pushed.

### Reconnect semantics

The parent holds a bounded per-run ring buffer (2000 events / 1 MB) with a **per-child
cursor**. It is a fast path, never a correctness dependency:

| case | child's cursor | what happens |
|---|---|---|
| transient drop (listener dropped, tab backgrounded) | preserved, `≥ lowWater` | replayed **from memory**, no server round-trip |
| full iframe reload (SDK state wiped, cursor back to 0) | `< lowWater` | tail torn down and re-opened at `?since=<cursor>` — the **server** replays |
| run expired from retention (>5 min after finish) | any | the events route 404s; the session is marked `finished`/`expired` and nothing more can arrive. The app falls back to conversation history, exactly like any other viewer of an expired run |

`lowWater` is the highest `seq` **not** retrievable from the cache. Events at or below every
attached child's cursor are dropped (NFR-002), so in steady state the buffer holds only what
hasn't been pushed yet; the hard caps are the backstop for a run that starts before its
child attaches. Overflowing the cache is never data loss — it degrades to one re-fetch
against the authoritative log.

### The single-tail constraint

**Never open a second concurrent subscription for the same run.** Two readers interleaving
into one buffer reintroduces exactly the out-of-order hazard the cursor model exists to
prevent. The module enforces this with a `tailing` flag plus a `generation` counter:
restarting at an earlier cursor bumps the generation, which makes the old loop stop
appending at its next checkpoint, and resets the buffer to that cursor so replayed events
append in order.

---

## Isolation and lifecycle

Broker state lives in a **module-level `Map<appId, AppBroker>`**, not in the `IframeApp`
component (ADR-3). That buys three things:

- **cross-app isolation** — each `AppBroker` records the runs *its* app started; a runId
  belonging to another app is reported as `unknown run`, so guessing one leaks nothing.
  (`assistant:active-run` is the one method that isn't app-scoped: it answers a question
  about a *conversation*, exactly as the direct-HTTP path does, and an app cannot guess
  another app's conversation id.)
- **survives an iframe reload** — the tail keeps running while the child's JS restarts; the
  child re-attaches at cursor 0 and the server replays.
- **survives a mid-run capability revoke** — revoking re-registers the manifest and re-runs
  `IframeApp`'s message-listener effect. The refcount lives in its own effect keyed only on
  `[appId, windowId]`, so the broker isn't torn down: in-flight deliveries continue (the run
  is server-owned) while *new* calls reject at the gate. This is the spec's "capability
  revoked mid-run" case.

The registry is keyed by `appId` but `IframeApp` is one instance per **window**, so entries
are **refcounted**: `retainBroker` on mount, `releaseBroker` on unmount (which also drops
that window's subscriptions so its stale cursor stops pinning the buffer). Teardown happens
only when the last window closes, after a short grace period so a window that remounts in
the same tick keeps its live tail.

---

## Frontend tool round-trip

Surface tools ride `startRun`. When the model calls one, the server's loop parks on
`awaitFrontendResult(run, callId, timeout)` and emits a `tool_call` event with
`execution: "frontend"`, which flows through the buffer to the child unmodified. The app
executes it locally and calls `assistant:tool-result`; the broker `POST`s
`/tool-results`, which calls `submitToolResult` — **first claim wins**, duplicates get
`{claimed: false}`. The broker adds no claim logic of its own, which is what preserves that
guarantee by construction. A post for a finished or unknown run relays the server's 404:
accepted, ignored.

---

## Using it from an app

```js
const { runId } = await window.__bos.assistant.startRun({
  conversationId: "my-app-chat",
  agentId: "assistant",
  message: text,
  surfaceTools: [{ name: "my_app_edit", description: "…", parameters: { /* JSON Schema */ } }],
});

const stop = window.__bos.assistant.onRunEvent(runId, async (e) => {
  if (e.type === "text_delta") append(e.delta);
  if (e.type === "tool_call" && e.execution === "frontend") {
    const result = await runMyTool(e.name, JSON.parse(e.args || "{}"));
    await window.__bos.assistant.postToolResult(runId, e.callId, result);
  }
  if (e.type === "run_finished") stop();
});
```

`onRunEvent` tracks the last-seen `seq` per run and attaches at that cursor, so a
re-subscribe resumes exactly where it left off; a reload resets it to 0 and the parent
takes the authoritative path. It calls `events-attach` once per run — the parent holds one
tail, so asking twice buys nothing and a second replay would duplicate events.

---

## What this feature did NOT change

`src/app/api/assistant/**` and `src/lib/assistant/run-manager.ts` are integration points,
not deliverables. Direct-HTTP consumers — same-origin (`origin: "local"`) apps and BOS's
own chat via `run-client.ts` — are untouched; the broker is a parallel path.

### Known drift (pre-existing, not introduced here)

`storage` is in `AppCapability` and `CAP_FOR_METHOD` but in **neither** `VALID_CAPS` nor the
`AppsTab` list — it is grantable at install time but not from the Settings toggle. Do not
copy that pattern: a new capability must be added to both, as `assistant` is. Recorded in
`user-specs/discrepancies.md`.
