# Design heuristics & gotchas

Hard‑won rules baked into the code. Violating these is how BOS breaks subtly.

---

## Server vs. client

- Server‑only modules start with `import "server-only";` and may use Node
  (`fs`, `child_process`). They can only be imported by route handlers / server
  components.
- Client components start with `"use client";`.
- `src/os/types.ts` and the `workflows/types.ts`‑style "types" files are
  framework‑free **on purpose** — safe to import from both sides. Keep them that way.

## Hydration

`src/app/page.tsx` SSR‑seeds the store. The **first client render must match the
server markup** — don't introduce client‑only initial state. `desktop.spec.ts`
fails on hydration mismatch; treat it as a tripwire.

## The VFS is not the source tree

File tools + Files app see only `data/vfs`. BOS source is edited via the developer
agent's repo‑scoped tools, jailed to the repo (`src/lib/dev/repo-fs.ts`). Never look
for BOS code in the VFS.

## Atomic writes everywhere under `data/`

Use `writeFileAtomic` (temp + rename). It's the contract that makes the DataFS
**hardlink** isolation safe (a write creates a new inode; the shared canonical file
is never mutated). A non‑atomic write breaks preview isolation and crash‑safety.

## `data/` schema must be backward-compatible

The Supervisor shares one canonical `data/` across versions and **promote is
code‑only**; a (deferred) **rollback** would run older code on the same data. So any
storage change must be readable by the previous version. Migrate forward‑compatibly.

## Streaming events live outside React

Card‑collapse timers live in a **module‑level** store (`card-collapse.ts`), not in
components, because the chat remounts cards while streaming and would clear
per‑component timers. Sub‑agent/workflow progress streams as **NDJSON** so it
appears live, not batched at the end (`subagent-events.ts`, the run routes).

## Never resume an in-flight turn

`loadConversationMessages` trims to a settled tail (`trimToSettledTail`);
`saveConversationMessages` refuses to overwrite a non‑empty thread with an empty
snapshot. Guarded by `no-uncommanded-run.spec.ts`. Don't bypass these.

## Reasoning models need token headroom

Always pass the **configured** `maxTokens` to LLM calls — never a tiny hardcoded
cap. Reasoning models spend output tokens on hidden thought first; too small a cap
yields an empty reply. Surface `reasoning_content`/`<think>` as a "thinking" stream.

## Secrets stay server-side

Provider key lives in `data/provider.json`, **masked** in `/api/agent/provider` and
`/api/config`; OpenAI calls go through the in‑app proxy so the key never reaches the
browser. Mark new sensitive fields `secret: true`.

## Development is Claude-only

No coding with the local model. For a **non‑dev** task on a Claude agent, ask
permission first (`requestClaudeAgentPermission`). If the harness is unavailable,
say so — don't silently fall back.

## Graceful degradation

MCP servers, browser automation, and Playwright **degrade** when unavailable
(no tools rather than hard errors). Preserve this — gate features on capability
probes (`detectPlaywright`, MCP probes, `supervisorEnabled`).

## Prefer existing layers over new ones

Three storage layers exist for a reason (source / DataFS `data/` / GitFS `apps/`).
Pick the right one; don't invent a fourth path. Memory vs. skills is a real
distinction — *who/what* vs *how*. Don't add a third knowledge store.

## Only `instrumentation.ts`'s `register()` ever runs — nothing else is automatic

Next.js calls exactly one function at server boot: the `register()` exported
from the file literally named `instrumentation.ts`. It does **not** also load
sibling files by naming convention — `instrumentation.node.ts` existing next
to it, exporting its own `register()`, changes nothing on its own. This bit
`user-specs/002-service-daemons`'s entire boot sequence (`seedUserApps()`,
`serviceRegistry().initialize()`, `serviceManager().startAll()`, the scheduler
daemon) for an unknown period: the code was correct and looked wired up, but
`instrumentation.ts` was a no-op stub, so none of it ever ran — `data/user-apps/`
didn't even exist on disk. No error, no warning; it just silently never fired.
If you split boot logic into a separate file (e.g. to keep Node-only code out
of the Edge bundle), `instrumentation.ts` MUST explicitly `import()` and call
it — gate on `process.env.NEXT_RUNTIME === "nodejs"` if it's Node-only. After
adding or changing boot-time logic, **verify it actually ran** (check logs, or
a file/directory it's supposed to create) — don't trust that the code exists.

## Turbopack breaks `new Worker(dynamicPath)` — tests won't catch it

`next dev`'s Turbopack bundler intercepts every literal `new Worker(...)` call
site and tries to statically resolve its first argument as a bundlable module.
For a path computed at runtime (e.g. a user-installed service's entry script,
entirely outside the bundle — see [Service Daemons](apps/services.md)), this
fails at runtime with `Cannot find module 'unknown'`, even though the exact
same path works fine via plain Node. Unlike `import()`/`require()`, this is
**not** suppressible with `/* webpackIgnore */` / `/* turbopackIgnore */`
comments. The fix is to build the constructor call from a string via `new
Function(...)` so the literal `new Worker(` text never appears in the source
for Turbopack's parser to see (`ServiceManager.ts`'s `createNodeWorker`).
**Critically: the Playwright unit test suite runs in plain Node and never
touches Turbopack**, so 120 passing tests gave zero signal that this was
broken — it only surfaced by actually running `npm run dev` and hitting the
real HTTP endpoint. Any code path involving `new Worker(...)`, dynamic
`import()`, or similar bundler-sensitive constructs needs a live `npm run dev`
smoke test, not just unit tests, before you trust it.

## Opaque-origin sandboxed apps can't `fetch()` BOS APIs directly

A `marketplace`-origin installed app (see [Apps guide §Trust tiers](guides/apps.md#trust-tiers-the-sdk--sandbox-028))
runs in an iframe sandboxed **without** `allow-same-origin`, so the browser
gives it a unique opaque origin (`Origin: null`). A direct `fetch("/api/...")`
from inside it is therefore cross-origin, and since BOS's own API routes
intentionally set no CORS headers (opening them up would let any origin read
or mutate BOS state), the request fails with a generic, unhelpful
`NetworkError` — no CORS error message, just "could not reach" whatever you
fetched. This is exactly the failure mode the Terminal app hit once installed
as a real app (it worked fine opened via `window.open()`, which isn't
sandboxed). The fix is never "open CORS" — route the call through the
`window.__bos` postMessage broker (`IframeApp.tsx`'s `dispatch()`, gated by an
`AppCapability` the user must explicitly grant in Settings → Apps), the same
pattern `fs`/`settings`/`storage` already use. Adding a new broker method means
touching **four** places that must all agree: `AppCapability` in
`src/os/types.ts`, the checkbox list in `AppsTab.tsx`, the server-side
`VALID_CAPS` allowlist in `src/app/api/apps/[id]/capabilities/route.ts`
(silently drops any capability not listed there — no error), and the
dispatch case + `CAP_FOR_METHOD` entry in `IframeApp.tsx`, plus the client
wrapper in `src/lib/iframe-sdk/index.ts`. Also: `src/app/__bos/sdk.js/route.ts`
is dead code (a Next "private folder" path that never registers as a route —
see its own comment) — the SDK actually served/inlined comes from
`src/lib/iframe-sdk/index.ts` via `src/app/api/iframe-sdk/route.ts` and the
`/apps/[...slug]` route's esbuild inlining. Don't edit the dead copy.

## An app with zero granted capabilities gets no broker responses — calls hang, they don't reject

`IframeApp.tsx`'s message listener used to skip registering itself entirely
when `capSet.size === 0` ("no grants — nothing to do"). That's wrong for any
app that calls `window.__bos` unconditionally and expects a clean rejection
if the capability isn't granted (Terminal does exactly this, to read its own
service's port before falling back). With the listener never registered,
`window.parent.postMessage(...)` goes into the void — the SDK call's promise
never resolves **or** rejects, so the app just hangs forever on whatever
"loading" state it started in. This looks exactly like a slow network from
the outside (easy to mistake for the opaque-origin `NetworkError` above) but
is actually "waiting on a response that will never come." The listener must
always be registered; a zero-capability app should still get an immediate
`Capability "X" not granted` rejection, same as a capability-having app
calling an ungranted method. Verified live with Playwright + real Chrome
(`channel: "chrome"`, since bundled Chromium isn't downloaded in this
environment) driving the actual desktop UI — not just curl against the API.

## `dataDir()/user-apps/` is the user's own repo — BOS never seeds it or deletes from it

An earlier iteration of Service Daemons (002-service-daemons) shipped example
items (Terminal, Workflow Manager) by additively copying `seed/user-apps/` into
`dataDir()/user-apps/` on every boot (`copyMissing()` — never overwrites, so a
seed-file fix never reached an already-materialized copy; a real, previously
hit gotcha). That mechanism is now **removed**. `dataDir()/user-apps/` is
conceptually identical to `user-specs/`: the user's own GitFS repo (they may
clone their own remote into it), which BOS only ever runs `ensureRepo()` on
(idempotent — a no-op if it's already a repo) and never populates, seeds, or
deletes from. Consequently `uninstallService()` (`serviceInstaller.ts`) MUST
NOT delete an item's directory there — uninstalling is purely
symlink-create/remove, exactly like adopting a spec never deletes the user's
spec store. If you need a runnable example to develop against, build one
yourself under your own `dataDir()/user-apps/<id>/`, or look at
`tests/services/`'s synthetic fixtures — there's no shipped reference item to
fall back on anymore.

## A service's own port doesn't survive deployment behind a reverse proxy — go through the Supervisor instead

The Terminal service example originally had the browser connect directly to
`ws(s)://<page-hostname>:<bound-port>` — the service's own network port. Real
deployment (`bos.schmopilot.com` on Dokploy) surfaced why this is fragile the
moment BOS isn't accessed as plain `http://localhost:3000`:
1. **Mixed content**: a page loaded over `https://` cannot open a plain
   `ws://` socket at all — the browser blocks it outright ("the operation is
   insecure"), no exceptions. Client code must pick `wss:`/`ws:` based on
   `location.protocol`, never hardcode one.
2. **Reachability**: even after fixing that, `wss://host:<port>` still needs
   that exact port to be (a) exposed by whatever reverse proxy sits in front
   and (b) TLS-terminated for that port specifically — neither of which the
   service itself provides (it's a plain, non-TLS `ws` server). A reverse
   proxy by default only forwards BOS's main app port.

**Fix**: don't expose the service's port at all — proxy its WebSocket through
the port that's already exposed and TLS-terminated. Every Docker deployment of
BOS already runs the **Supervisor** (`tools/supervisor/supervisor.mjs`) owning
the public port, and the Supervisor already had a raw `http.Server` with a
`server.on("upgrade", ...)` handler forwarding Next dev's HMR socket to the
pinned version — the exact primitive needed, just never used for a service's
own socket. Added `proxyServiceUpgrade()`: a new path,
`/__supervisor/services/<id>/ws`, resolves the service's actual bound port
from `<pinned version's dataDir>/config/<id>/runtime.json` and forwards the
upgrade there. `GET /api/services/<id>/config` surfaces this as a `wsPath`
field whenever `supervisorEnabled()` is true (checks `BOS_SUPERVISOR_URL` —
`src/lib/devharness/supervisor.ts`); client code should prefer
`${wsScheme}//${location.host}${wsPath}` when `wsPath` is present, falling
back to direct `host:port` when it's absent (plain `npm run dev`, no
Supervisor in front — already works, unaffected). The initial instinct here
was "we need a proxy in the multi-user `bastion/` reverse proxy" — turned out
to be unnecessary: bastion already forwards WebSocket upgrades transparently
(`http-proxy-middleware` with `ws: true`) to the Supervisor's port, so the fix
only needed to happen once, downstream, in the Supervisor itself. Any new
service with its own network port should follow this same pattern from the
start.

**Also learned the hard way**: never run `npm run supervisor` directly against
a live working checkout with uncommitted changes in it. The Supervisor's
startup safety gate (`git reset --hard HEAD` + `git clean -fd` on `REPO`,
guarding against the live base checkout drifting) treats any uncommitted edits
as unexpected drift and silently wipes them — no warning, no confirmation.
Commit first, or point `BOS_REPO` at a disposable clone, before testing
anything under the real Supervisor.

## Keep mirrors in sync

`tool-manifest.ts` mirrors the registered actions (Tools panel). `specs/` mirrors
architecture. `docs/usage` + `docs/dev` (the source trees the in‑OS Docs app renders) mirror features for users and developers. Update all relevant mirrors
when you change behavior — and record intentional spec divergence in
`specs/discrepancies.md`.
