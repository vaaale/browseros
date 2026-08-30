# Event & Notification System (034)

BOS's pub/sub event broker: a core event kernel (a `globalThis` singleton
daemon, sibling to the scheduler daemon) that accepts events from any BOS
component, stores them durably with indefinite retention, fans out to
registered **headless handlers** automatically, and exposes a built-in
**Event Viewer** app + topbar bell for user-facing triage. **UI handlers**
make events actionable when the user clicks them.

Source: `src/lib/events/` (kernel), `src/app/api/events/` (HTTP routes),
`src/apps/event-viewer/` (built-in app), `src/components/desktop/EventBell.tsx`
(topbar), `src/lib/assistant/tools/server/events.ts` (agent tools).

Spec: `specs/user-specs/core-platform/034-event-notification-system/`
(spec.md, design.md, data-model.md, contracts/event-api.md are authoritative
for requirements/architecture — this doc is the practical how-to).

---

## 1. Mental model

Two orthogonal axes on every event:

- **Processing**: `pending` → `processed`. Driven by headless handlers
  acknowledging (or permanently failing) the event. An event with no active
  headless handlers is processed immediately on emission.
- **Read**: `unread` → `read`. Driven by the user viewing the event in the
  Event Viewer (or `mark_events_read`). The topbar bell shows the **unread**
  count — not pending.

Two handler modes:

- **Headless** — invoked automatically by the kernel on emission. Runtime-
  declared by a running worker-thread service (`handler_declare` over
  worker IPC) or registered directly in-process by core code. Participates
  in the processing model: it must ack (or be retried to permanent failure)
  before the event can complete.
- **UI** — declared statically in an app's manifest (`AppManifest.eventHandlers`).
  Invoked only when the user clicks a matching event in the Event Viewer.
  Never acks, never affects `processing`.

---

## 2. The public API — one contract, three transports

`src/lib/events/api.ts` is the single implementation. It is reached by:

| Transport | Who | How |
|---|---|---|
| In-process | agent tools, core code | `import * as api from "@/lib/events/api"` — no HTTP hop |
| Same-origin HTTP | Event Viewer, bell (browser) | `fetch("/api/events/...")` |
| Loopback HTTP | worker-thread services | `src/lib/events/loopback.ts` — `http://127.0.0.1:$PORT/api/events/...` |

The agent tools (`src/lib/assistant/tools/server/events.ts`) wrap the exact
same operations: `emit_event`, `query_events`, `get_event`, `ack_event`,
`mark_events_read`, `set_event_preference`, `list_event_handlers`.

### Operations

| Op | In-process | HTTP |
|---|---|---|
| Emit | `api.emit({type, payload, source})` | `POST /api/events` |
| Query | `api.query(filter)` | `GET /api/events?type&status&read&from&to&cursor&limit` |
| Get one | `api.getEvent(id)` | `GET /api/events/:id` |
| Ack | `api.ack(id, {handlerId, result, callerId})` | `POST /api/events/:id/ack` |
| Mark read | `api.markRead(id)` | `POST /api/events/:id/read` |
| Mark all read | `api.markAllRead()` | `POST /api/events/read?all=1` |
| Register | `api.register({...})` | `POST /api/events/register` |
| Unregister | `api.unregister(handlerId, ownerId)` | `POST /api/events/unregister` |
| Set/clear preference | `api.setPreference(type, handlerId \| null)` | `POST /api/events/preference` |
| Count (bell) | `api.count()` | `GET /api/events/count` |
| List handlers (config) | `api.listHandlersGrouped()` | `GET /api/events/handlers` |
| Enable/disable | `api.setEnabled(handlerId, ownerId, enabled)` | `POST /api/events/handlers` |
| Live stream | — | `GET /api/events/stream?since=<seq>` (NDJSON, replay-then-tail) |

Full request/response shapes: `contracts/event-api.md` in the spec store.

### Errors

Uniform envelope: `{ "error": { "code": string, "message": string } }` with
a matching HTTP status. In-process callers get a thrown `EventApiError`
(`src/lib/events/types.ts`) with the same `code`/`message`, plus `.status`.

| Code | HTTP | Meaning |
|---|---|---|
| `invalid-type` | 400 | Bad request shape (type, mode, missing fields). |
| `payload-too-large` | 413 | Payload > 1MB. Use a VFS path reference instead. |
| `namespace-not-owned` | 403 | `register` outside the owner's root/grants. |
| `ack-forbidden` | 403 | Caller doesn't own the handler/registration. |
| `already-settled` | 409 | Conflicting terminal ack (already permanently failed). |
| `invalid-preference` | 400 | `preferredHandlerId` isn't a UI handler for the type. |
| `not-found` | 404 | Unknown event/handler id. |

---

## 3. Emitting an event

```ts
import * as api from "@/lib/events/api";

await api.emit({
  type: "com.bos.myapp.thing.happened",
  payload: { summary: "Something happened", detail: "..." },
  source: { appId: "myapp", name: "My App", icon: "Zap" },
});
```

- `type`: dot-separated, lowercase, ≤256 chars, matching `^[a-z0-9]+(\.[a-z0-9_-]+)+$`.
- `payload`: any JSON object, ≤1MB serialized. Include an optional `summary`
  string field — the Event Viewer's list uses it directly; otherwise it
  falls back to a truncated stringification.
- `source.appId`: your component's id — this is also the root of the event
  namespace you own (`com.bos.<appId>.*`).
- Durably recorded before the call returns (a single O(1) shard append —
  never blocks on handler completion).

**Payload > 1MB**: rejected with `413 payload-too-large`. Put large data on
the VFS and reference its path in the payload instead.

From a worker-thread service (no `@/` imports available), use the loopback
client:

```ts
import { emitEvent } from "path/to/loopback-client"; // see loopback.ts's shape
await emitEvent({ type: "com.bos.myservice.thing.happened", payload: {...}, source: {...} });
```

(A worker can't `import` `src/lib/events/loopback.ts` directly either — copy
its two-line `fetch` shape, or call `fetch("http://127.0.0.1:" + process.env.PORT + "/api/events", {...})` inline. See §6 for why this is the only path.)

---

## 4. Registering a headless handler (worker-thread services)

Headless handlers are **runtime-declared**, not manifest-declared — a
service posts `handler_declare` over its existing worker-IPC channel at
startup (the same shape as 039's `tool_declare`):

```ts
// inside a service's own worker entrypoint
const { parentPort } = require("node:worker_threads");
parentPort?.postMessage({
  type: "handler_declare",
  payload: {
    callId: "some-unique-id",
    handlerId: "my-handler",
    eventType: "com.bos.myservice.thing.happened", // or "com.bos.myservice.*"
    displayName: "My Handler",
    description: "Processes things",
    timeoutMs: 30000, // optional, default 30000 (NFR-006)
  },
});
```

BOS's `ServiceManager` picks this up (`src/core/service/ServiceManager.ts`,
`handleWorkerMessage`'s `handler_declare` case) and calls
`api.register({..., mode: "headless", ownerId: <serviceId>, declaredBy: "service"})`
on your behalf. Re-declaring the same `handlerId` is an idempotent upsert —
it **preserves** a previously-disabled state, so redeclaring on every
service restart is expected and safe.

The kernel then invokes your handler (Main→Worker `event_dispatch`, one at a
time per handler — FIFO, concurrent across different handlers) whenever a
matching event is emitted. You process it, then **ack over loopback HTTP**:

```ts
await fetch(`http://127.0.0.1:${process.env.PORT}/api/events/${eventId}/ack`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    handlerId: "my-handler",
    callerId: "<your-service-id>", // must match the handler's ownerId (FR-022)
    callId,                        // from the event_dispatch payload — exactly-once-settle guard
    result: { ok: true },          // optional
  }),
});
```

### Idempotency (required)

Delivery is **at-least-once**: un-acked events are re-dispatched on BOS
restart and on late handler registration. **Your handler MUST be
idempotent** — it may receive the same event more than once and must
produce the same end state (no duplicate side effects) each time. A common
pattern: key your side effect by the event's `id` and skip if already
applied.

### Retry / timeout semantics

- Default per-invocation timeout: 30 seconds (`timeoutMs` in your declaration).
- On failure (exception, or no ack within the timeout): retried up to 3
  times total, with backoff of 1s, 5s, then a final 30s wait before the
  handler is marked **permanently failed** for that event.
- A permanently-failed handler does not block the event from completing —
  the event transitions to `processed` (`processedReason: "all-settled-with-failures"`)
  once every other active handler has also settled.
- A **disabled** handler (via the Configuration tab) or one whose service
  isn't running is **not active** — it's excluded from the completion check
  entirely, so it can never block an event.

### Core-internal headless handlers

BOS-core code (no service, no IPC) can register a headless handler directly:
`dispatch.registerCoreExecutor(handlerId, async (record) => ({ result }))`,
then `api.register({..., declaredBy: "core"})`. The dispatch engine calls it
as a plain function and settles the ack synchronously — no ack call needed.

---

## 5. Registering a UI handler (any app)

Declare it statically in your app's manifest — no runtime call needed:

```ts
// src/apps/my-app/manifest.ts (built-in) or app.json (installed)
const manifest: AppManifest = {
  id: "my-app",
  // ...
  eventHandlers: [
    {
      id: "my-handler",              // unique within this app
      type: "com.bos.gsuite.email.received", // exact type or "prefix.*"
      displayName: "Open in My App",
      description: "Shows the full record",
      icon: "Mail",                  // optional, defaults to the app's own icon
    },
  ],
};
```

At boot, `src/lib/events/register-ui-handlers.ts` surfaces every built-in and
installed app's `eventHandlers` into the registry (`handlerId` becomes
`<appId>:<declaration.id>`, globally unique). When the user clicks a
matching event with exactly one UI handler (or a user-set default), BOS
`launch()`es your app's window with `params.event = { id, type, seq }` — read
it and, if you need the full payload, `GET /api/events/:id`.

Your app doesn't need to import the events kernel at all to receive this —
it's just a launch param, same as any other `launch(appId, params)` call.
An installed (iframe) app receives the same `{id, type, seq}` via URL query
params (`bosEvent`, `bosEventType`, `bosEventSeq`, `bosHandler`) since it
can't receive arbitrary React props.

UI handlers **never** call `ack` and **never** affect `processing` — they
are a pure display/interaction layer (FR-014).

---

## 6. Namespace ownership (FR-023)

A component may register a handler (headless or UI) for an event type only
if that type falls under:

1. **Its owned root** — `com.bos.<yourId>.*`, derived automatically from
   your component id (the same id used as `source.appId` / a service's
   `service.json` `id` / a built-in app's manifest `id`). No declaration
   needed.
2. **A granted namespace** — a static `eventNamespaces: string[]` list in
   your manifest (built-in `AppManifest.eventNamespaces`) or `service.json`.
   Each entry is a namespace prefix (`"com.example.shared.*"`) or exact type.

Violating this returns `403 namespace-not-owned`. This is a same-container
integrity check, not a network security boundary (BOS's single-container
trust model) — it exists to catch accidental collisions between components,
not to defend against an adversary inside your own container.

The same rule governs `ack` ownership (FR-022): the caller's declared
`callerId` must match the handler's registered `ownerId`, or you get
`403 ack-forbidden`.

---

## 7. Why loopback HTTP for worker-thread services

A worker-thread service can't `import` any `@/`-graph module (it's an
unbundled, plain-Node entrypoint) — the same restriction that already
applies to VFS access and secrets verification. It reaches BOS's public API
the same way it reaches `/api/fs` and `/api/secrets/<service>/verify`: a
plain loopback HTTP call to its own serving process,
`http://127.0.0.1:${process.env.PORT}/api/events/...`. See
`docs/dev/os-shell/virtual-file-system.md` and
`docs/dev/features/headless-client-auth.md` for the established pattern this
follows.

---

## 8. Storage (for anyone touching `src/lib/events/store.ts`)

Files under `data/events/` (gitignored):

```
data/events/
  index.json              # warm-in-memory projection, flushed on checkpoint only (30s / 500 changes)
  events/<YYYY-MM>.jsonl  # immutable event bodies, append-only (O(1) per emit)
  state/<YYYY-MM>.json    # mutable per-event state for that month
  handlers.json           # handler registry (written immediately on register/unregister)
  preferences.json        # default-UI-handler preferences (written immediately)
  .migrated-integrations  # marker file — legacy-inbox migration ran once
```

Event **bodies** are the source of truth; the index and per-month state are
derived projections held warm in memory and only periodically flushed — this
keeps the emit hot path to a single O(1) shard append (no per-emit rewrite
of the ever-growing index). If a crash loses a sub-checkpoint change, boot
repairs the index by rescanning the shards, and any lost in-flight dispatch
state is covered by at-least-once re-dispatch. See `ADR-4` in the spec's
`design.md` for the full rationale.

---

## 9. Testing

Unit tests: `tests/events/*.test.ts`, run via `npm run test:unit`. Each test
uses an isolated store root (`tests/events/_test-env.ts`'s
`useEventTestRoot()`) and resets every hot-reload-safe singleton
(`store._resetKernelForTests` via `kernel._resetKernelForTests`,
`dispatch._resetDispatchForTests`, `stream._resetStreamForTests`) — tests
never leak state into each other or pollute a real `data/events/`.

E2E: `e2e/034-event-notification-system.spec.ts`, run via `npm run test:e2e`.
Each test reverts what it created (events/handlers/preferences/UI state) in
`afterEach` so the suite is order-independent and never pollutes the user's
real event store.
