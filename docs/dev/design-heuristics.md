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

## Windows are `transform`-positioned — `position: fixed` UI inside one needs a portal

`Window.tsx` positions every app window with a CSS `transform`, which makes the
window the containing block for any `position: fixed` descendant — a naive
`fixed inset-0` modal or `fixed left/top` context menu built inside an app
resolves against the window's own bounds, not the real viewport, so it renders
offset by wherever the window has been dragged (found via a real Build Studio
context menu appearing far from the click point). Portal to `document.body`
(`createPortal`) for any fixed-position overlay/menu — see
`scheduler/index.tsx` or `build-studio/Dialogs.tsx`/`HistoryDialog.tsx`. The
style guide's Modal/dialog recipe (`guides/style-guide.md` §"Modal / dialog")
assumes this too — copy the portal along with the JSX, not just the JSX.

## Native `window.confirm`/`alert`/`prompt` risk a React "flushSync" warning

A synchronous blocking dialog re-enters the event loop mid-handler, which can
collide with a `useSyncExternalStore`-backed update that follows it (e.g. the
conversations store), tripping React 18's "flushSync was called from inside a
lifecycle method" warning. Use a styled dialog (the `ConfirmDialog`/
`PromptDialog` pattern) or a lightweight inline arm-then-click-again
interaction instead — see `AgentSelector.tsx`'s conversation-delete button.

## The VFS is not the source tree

File tools + Files app see only `data/vfs`. BOS source is edited via the developer
agent's repo‑scoped tools, jailed to the repo (`src/lib/dev/repo-fs.ts`). Never look
for BOS code in the VFS.

## Atomic writes everywhere under `data/`

Use `writeFileAtomic` (temp + rename). It's the contract that makes the DataFS
**hardlink** isolation safe (a write creates a new inode; the shared canonical file
is never mutated). A non‑atomic write breaks preview isolation and crash‑safety.

`writeFileSync` opens with `O_TRUNC`: it empties the file *before* attempting the
write, so a write that then fails leaves **zero bytes**, not the old content. The
bastion's instance registry was found at 0 bytes after the host hit its disk quota
for exactly this reason. This applies to the bastion's own `/data` too, which has
no `writeFileAtomic` to reach for — write the temp file and `rename` it by hand.

## Probe a capability by performing it, against the real pair of paths

A probe that tests something *adjacent* to the operation reports on the wrong
thing, and the report is then trusted. DataFS asked "can this filesystem
hardlink?" by linking a file to its own sibling inside `data/` — always true —
when the operation is a link from `data/` into the **clone root**, a different
bind mount in the bastion, where `link(2)` returns `EXDEV` on every file. The
answer was "hardlink isolation available" on a deployment where it was
impossible, and the clone layer silently degraded to a full copy per branch until
a production disk filled.

Related: a **fallback that hides a failure** is the second half of that bug.
`provisionClone` now returns the method it *actually* used, and an explicitly
configured method that cannot work is an error, not a warning nobody reads.

## A test running inside BOS can modify BOS

BOS is a product that runs its own test suite. A self-modifying agent typing
`npm run test:unit` is a NORMAL thing here, and that process inherits the live
deployment's coordinates — `BOS_SUPERVISOR_URL`, `BOS_SPECS_ROOT`,
`BOS_CANONICAL_DATA`, `BOS_REPO`. Anything in `src/` that resolves a path or an
endpoint from the ambient environment will therefore, in a unit test, resolve
the **running deployment**.

This has now happened three times: ~50 stray projects in a live spec store, 8
corrupt conversation fixtures in a real data dir, and 18 fixture-named `bos/*`
branches — each with a full copy of an 8.5 GB data dir — created through the
live Supervisor's `/__supervisor/begin`. Every one of them was invisible on a
developer machine, where nothing is listening and the ambient vars are unset.

`tests/_no-live-deployment.cjs` and `tests/services/_test-env.ts` are the two
enforcement points. When you add an env var that names something live, add it
to one of them in the same change.

## Discovery must not provision

Scanning for things (branches, items, stores) is cheap and runs at boot; building
them is not. `restorePreviews()` used to materialize a worktree + data clone for
every `bos/*` branch it found, for previews its own comment called "not-built" —
~200 GB of copying per restart on a box with 21 abandoned branches. Register what
you discover; pay on first use.

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

## There is exactly ONE instrumentation file: `src/instrumentation.ts`

Next.js calls exactly one function at server boot: the `register()` exported
from the file literally named `instrumentation.ts`. Two traps follow, and BOS
has fallen into both.

**Trap 1 — sibling files are not discovered.** `instrumentation.node.ts`
existing next to it, exporting its own `register()`, changes nothing. A Jul 22
commit renamed `src/instrumentation.ts` → `src/instrumentation.node.ts` and
thereby disabled the whole boot sequence (`ensureRepo(user-apps)`,
`serviceRegistry().initialize()`, `serviceManager().startAll()`, the scheduler
daemon). No error, no warning; `data/user-apps/` didn't even exist on disk.

**Trap 2 — root and `src/` both count, and one silently wins.** Next resolves
the hook from EITHER `<root>/instrumentation.ts` OR `<root>/src/instrumentation.ts`.
A Jul 28 commit added a root-level one to load BOS plugins, which displaced
`src/instrumentation.ts` and killed the same boot sequence a second time, in
both dev and production. Which file wins is not even stable between machines.

Therefore: **keep all boot logic in `src/instrumentation.ts` itself.** Do not
create a root `instrumentation.ts`, and do not split Node-only logic into a
sibling module — the Edge-bundle rationale for splitting does not apply here
anyway (BOS has no Edge surface: zero `runtime = "edge"`, no `middleware.ts`,
empty middleware manifest). Gate the whole body on
`process.env.NEXT_RUNTIME === "nodejs"` instead.

After adding or changing boot-time logic, **verify it actually ran** — check
`data/logs/timeline-*.jsonl` for the components you expect (e.g.
`services.registry` logging `initialized`), or check a file/directory it
creates. Don't trust that the code exists.

## `globalThis` singletons dedup within a process, never across processes

BOS runs SEVERAL Node server processes over one data root: the Supervisor keeps
a BASE alive plus a PREVIEW while a feature branch is previewed, and `next dev`
adds more. `register()` in `src/instrumentation.ts` runs in every one of them.

So a `globalThis.__somethingStarted` flag — the right tool for Turbopack's
separate module graphs — buys nothing here, and neither does a module-level
`Set`. The scheduler shipped with both (`globalThis.__bosSchedulerState`, an
in-memory `runningJobIds`) and consequently ran one daemon per process: a single
due job fired N times, which turned the non-idempotent "Daily Review" job into N
concurrent agent runs (3-5x runtime, ~1M-token context errors) while idempotent
jobs hid the problem entirely.

Any boot-time singleton that owns a *shared resource* therefore needs a
filesystem lock, not a process-local flag — and the lock must be:

- **atomic**, i.e. a single `fs.link()`/`O_EXCL` create. A read-then-write
  ("no lock? then write one") loses the race by construction: every process
  reads "free" before any of them writes.
- **rooted in `BOS_CANONICAL_DATA`** when the contenders may be a base and a
  preview — they have DIFFERENT `BOS_DATA_DIR`s (a preview runs on a throwaway
  clone) and only canonical data is shared container-wide.
- **reclaimable**, via owner PID liveness plus a heartbeat, or a crashed owner
  wedges the subsystem until someone restarts the container.

See [Scheduler concurrency](automation/scheduler-concurrency.md) for the
implementation (`src/lib/scheduler/lock.ts`).

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
pattern `fs`/`settings`/`storage` already use. Adding a broker method **under
a brand-new capability** means touching **four** places that must all agree:
`AppCapability` in `src/os/types.ts`, the checkbox list in `AppsTab.tsx`, the
server-side `VALID_CAPS` allowlist in `src/app/api/apps/[id]/capabilities/route.ts`
(silently drops any capability not listed there — no error), and the
dispatch case + `CAP_FOR_METHOD` entry in `IframeApp.tsx`, plus the client
wrapper in `src/lib/iframe-sdk/index.ts`. A new method that reuses an
**existing** capability only needs the last two (`services.status`/
`services.call` were added this way, both under `services:read` alongside
the pre-existing `services.getConfig` — see docs/dev/apps/services.md §14).
Also: `src/app/__bos/sdk.js/route.ts`
is dead code (a Next "private folder" path that never registers as a route —
see its own comment) — the SDK actually served/inlined comes from
`src/lib/iframe-sdk/index.ts` via `src/app/api/iframe-sdk/route.ts` and the
`/apps/[...slug]` route's esbuild inlining. Don't edit the dead copy.

One capability breaks the request/response shape, and it's instructive:
`assistant` (040) relays a *stream*, and an NDJSON `ReadableStream` cannot cross
`postMessage`. The answer is not a WebSocket, a new route, or a service — it's to
notice that the **parent frame already has a same-origin fetch context**, so it
can own the reader loop and push each parsed event into the child as an
unsolicited `{__bos_event, runId, event}` message, with a bounded per-run buffer
so a reconnecting child can resume from its own cursor. When a broker method
needs more than a single round-trip, put the state in a module-level registry
next to `IframeApp` rather than reaching for new infrastructure. See
[the assistant broker](assistant/assistant-broker.md).

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

## `dataDir()/user-apps/` is a marketplace repo — same layout as any other

`user-apps` is the user's own **private marketplace**, and it is structurally
identical to the central one: a root `marketplace.json` plus items under
`items/<id>/`. That equivalence is the point — the same repository can serve as
either, so a maintainer can point `user-apps` at a published marketplace and
develop apps to share (`034-user-apps-marketplace-parity`). No code path may
assume a different shape for `user-apps` than for `dataDir()/marketplace/<id>/`.

Two things follow, and both reverse earlier rules:

**BOS maintains `marketplace.json` — deliberately.** The old rule was "BOS never
writes a generated artifact into this repo". That is replaced by a narrower
guarantee: BOS writes only the manifest, only by **merge**, and only when
something actually changed. A read that finds the manifest consistent leaves the
working tree clean.

**Merge, never regenerate.** A directory scan cannot reproduce curated metadata,
and regenerating would silently strip a real marketplace. Concretely, from the
central marketplace: `lunar-lander`'s entrypoint is `items/lunar-lander/app/dist`
(a scan probing `<id>/app/index.html` finds nothing); `live-avatar` declares
`runtime: "plugin-served"` and a `voiceEngine` facet with an `engineId`; several
items carry `tags`, `icon` and hand-written descriptions that exist *only* in the
manifest. So: add entries for new directories, prune entries whose directory is
gone, and never touch a field you did not author.

Still true from the earlier iteration: BOS does **not** seed example items (the
old additive `copyMissing()` from `seed/user-apps/` is gone — a seed-file fix
never reached an already-materialized copy), and `uninstallService()` MUST NOT
delete an item's directory. Uninstalling is purely symlink create/remove, exactly
as adopting a spec never deletes the user's spec store. For a runnable example,
build one under `items/<id>/` or see `tests/services/`'s synthetic fixtures.

**Moving item directories means re-pointing symlinks.** Installed state is a set
of *absolute* symlinks (`system/{services,app,settings,hooks}/<id>`,
`config/<id>`, `specs/external-specs/<id>`, `docs/external-docs/<id>`). Any
change to where items live must re-point every one of them and repair manifest
entrypoints, or every installed item silently dangles. See
`src/lib/marketplace/migrate-user-apps.ts`.

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

**Follow-up (a real WebDAV mount build hit this next)**: the WS-only version
of this fix quietly implied "a service that isn't a WebSocket has no
equivalent" — which isn't true, and an agent session burned real effort
inventing a plausible-looking but nonexistent `/services/<id>/` URL for a
plain-HTTP (WebDAV) service rather than checking whether the Supervisor's
pattern generalized. It does: `proxyTo()` (used for the pinned-version
fallback) was already a verb-agnostic raw-HTTP forwarder with no Next.js
involvement, so `proxyServiceHttp()` mirrors `proxyServiceUpgrade()` exactly —
same `runtime.json` port lookup, same `/__supervisor/services/<id>/...`
prefix, just on the plain request path instead of `upgrade`. `GET
/api/services/<id>/config` now also returns `httpPath` alongside `wsPath`.
Full writeup, including the multi-user Basic-auth composition:
[Service Daemons §11](apps/services.md#11-reaching-a-service-from-outside-the-container-read-this-before-designing-any-service-with-its-own-network-port).
The lesson generalizes: a limitation documented for one transport (WS) is not
evidence the same fix doesn't apply to another (HTTP) — check the underlying
primitive before assuming a gap.

**Also learned the hard way**: never run `npm run supervisor` directly against
a live working checkout with uncommitted changes in it. The Supervisor's
startup safety gate (`git reset --hard HEAD` + `git clean -fd` on `REPO`,
guarding against the live base checkout drifting) treats any uncommitted edits
as unexpected drift and silently wipes them — no warning, no confirmation.
Commit first, or point `BOS_REPO` at a disposable clone, before testing
anything under the real Supervisor.

## "The process is alive" is not "the feature works"

The Supervisor is PID 1 in a BOS container. It survives the death of the base
Next.js server, so the container keeps reporting `Up` while BOS is unreachable.
This produced a 10.5-hour production outage that nothing noticed — not Docker,
not the bastion, not the admin UI.

Generalise it: **anything that supervises a child must report on the child, not
on itself.** If you add a component that fronts another process, expose a
liveness signal that actually probes the thing users depend on
(`/__supervisor/health` probes base; the image `HEALTHCHECK` probes that). And if
you add a long-lived process, make its death observable and recoverable — an
unexpected exit should restart with bounded backoff and then *give up loudly*
rather than retry forever, so the status tells the truth instead of hiding a
crash loop.

## Log the signal, not just the exit code

`next dev` exits with code **0** when the kernel OOM-kills its `next-server`
child. Code-only logging therefore reported a clean shutdown for an
out-of-memory kill, which is exactly why the outage above stayed invisible for
hours.

Whenever you handle a child-process `exit`, take both arguments and report both:

```js
proc.on("exit", (code, signal) => { /* signal is the interesting one */ });
```

Treat a `SIGKILL`, or a code-0 exit from a process that was actively serving, as
a probable OOM and say so in the message. The cheapest confirmation is the
cgroup: `oom_kill > 0` in `/sys/fs/cgroup/memory.events` proves a kill happened,
and `oom == 0` alongside it proves the **host** ran out rather than the container
hitting its own limit.

## Dev mode is not a deployment mode

`next dev` keeps Turbopack's compiler resident in the serving process and grows
without bound under request load. Measured on identical code and identical
traffic:

| | `next dev` | `next start` |
|---|---|---|
| RSS at boot | 2181 MB | 130 MB |
| Per API request | +0.78 MB | +0.054 MB |
| 4 min sustained load | 2.4 → 7.1 GB, no plateau | 198 → 249 MB, plateaued |

On a 16 GB host the dev server reached a 15.8 GB peak and was OOM-killed. Base
therefore runs in production mode in any deployment (`BOS_BASE_DEV=0`); previews
always did. Local dev keeps dev mode but bounds it with
`BOS_DEV_MAX_OLD_SPACE_MB`, which caps the **heap** only — measured RSS lands at
roughly twice the cap, because about half the footprint is outside V8's old
space. That is a bound, not a fix; what retains memory per request in dev is
still unexplained.

## If a capability is gated on an env var, every spawn path must set it

`BOS_SUPERVISOR_URL` was set by only *one* of the Supervisor's two spawn paths
(the dev-mode base). Everything keyed off it silently degraded for anything
started the other way: the service-WebSocket proxy path advertised by
`/api/services/<id>/config` (so the Terminal app fell back to a direct
`host:3001` the browser cannot reach), Supervisor-backed git, and log shipping to
the central store. Nothing failed loudly; three features just quietly weren't
there.

The bug was latent for as long as only one path was in use, and surfaced the
moment the other became the default. When you add an env-gated capability, set
the variable in one shared place, or assert it on every path — do not rely on
each `spawn()` call site remembering.

## Health is observability; never let it gate traffic

The bastion tracks whether each instance is actually serving. An early version of
that also used the verdict to decide whether to proxy — so a single failed probe,
or a legitimate cold-start `next build` window, turned into a total outage where
every API call returned `503 "BOS instance not ready"` and the whole desktop
looked broken.

Keep the two concerns apart: report health for humans and dashboards; route
traffic on whether the container is up. When the upstream is genuinely down its
own error page is more useful than a synthetic one from the layer in front.

## Anything that stops something must log why

The bastion's idle reaper stopped containers with no log line at all, which made
overnight disappearances impossible to explain from the bastion log and cost real
diagnostic time. (The reaper is now removed — instances run until explicitly
stopped — but the rule outlives it.) Every stop, kill, prune or eviction should
record what it stopped and on whose behalf.

## A stale `.next` can outlive the file it references

Deleting or renaming a module that a cached Turbopack chunk points at leaves an
artifact referencing a path that no longer exists. A cold start recompiles and is
fine; an **in-process** dev-server restart loads the stale chunk and hard-fails:

```
Error: An error occurred while loading instrumentation hook:
Could not parse module '[project]/instrumentation.ts', file not found
```

Which means the hook did not run at all. `reprovisionUpdateSrc` already clears
`.next` for this reason; production base is immune because it builds in a fresh
worktree. If you delete or rename a module referenced from a build artifact,
clear `.next` once.

## Measure before attributing, and don't trust one sample

Two mistakes worth not repeating from the memory investigation:

- A single `top -H` snapshot showed Turbopack's `tokio` threads hot, and that was
  read as "the memory is Rust-side". A controlled measurement showed the opposite
  attribution for the growth. **One sample is not a measurement.**
- Capping V8's old space was assumed to cap RSS. It does not — RSS landed at ~2×
  the cap. Heap and RSS are different quantities; attribute by thread name
  (`tokio-runtime-worker` = Rust/Turbopack, `node`/`next-server` = V8) and prefer
  an A/B run under identical load over reasoning from a snapshot.

When you claim a cause, state what you measured and what you did not.

## Installing copies nothing — it is one symlink

Installed state is exactly one symlink per item:

```
data/system/<item-id>        -> the item, wherever it lives
                                 data/marketplace/<mktId>/items/<id>   or   data/user-apps/items/<id>
data/system/config/<item-id>/   real directory, seeded from the item's config/ defaults
```

Facets are found by a **depth-2 scan** of `data/system/` — `<id>/app/`,
`<id>/services/service.json`, `<id>/plugin/bos-plugin.json`, `<id>/spec/`,
`<id>/hooks/` — and uninstall is one `rm`. Config is the only permitted copy,
because it is mutable *state*: a service writes `runtime.json` there, which must
never land inside a read-only marketplace clone.

Three rules fall out of this, and each of them was a bug first:

**Never write into an item.** `app.json` belongs to whoever authored the item, and
for a marketplace item it sits in a clone. Provenance (`origin`, `marketplaceId`)
is *derived* from where the install symlink resolves, so there is nothing to
persist. An earlier revision wrote `app.json` into `user-apps/items/<id>/app/`
even for someone else's app — creating content in a repository the user may
publish, and colliding with the correct link into the clone.

**Never `rm` a path that resolves through the symlink.** `uninstallBosPlugin` did
`fs.rm(data/system/<id>/plugin)`, which resolves *into the marketplace clone* —
deleting the item's source instead of uninstalling it. Uninstall removes the
link, never the target.

**Capability grants are BOS state, not item content.** They live in
`data/system/config/<id>/capabilities.json`. A permission grant stored in
marketplace-controlled content could silently widen itself on the next `git pull`.

## One scanner per directory, or the registries will drift

Apps, services and plugins all read installed state, and each used to scan for
itself. That is how `ServiceRegistry` came to scan `user-apps` flat while the
marketplace client scanned `items/` — two subtly different scans that silently
disagreed about what existed, for an unknown period.

There is now exactly one implementation (`src/system/items/installed.ts`), and
every registry consumes it. If you add a subsystem that needs to know what is
installed, call it; do not add a fourth `readdir`.

## Migrations must run before the things that read what they move

Moving `configDirPath` to `data/system/config/<id>` without the migration in place
left services reading a directory that did not exist — starting configless and
failing to write `runtime.json`, which silently breaks anything resolving a
service's port. And loading plugins *before* the migration meant that on the very
boot which migrated them, nothing loaded: the old directory was no longer read and
the new facet did not exist yet.

When you move where something lives, the migration and every reader move in the
same change, and boot order has to put the migration first. Neither of those
failures showed up in `tsc` — only in running it.

## A platform's deploy checkout is not a git remote you can rely on

BOS fetches per-user source updates from the deployment's *own* working copy
(`/bos-src`). That looked like a free git remote and is not one: PaaS platforms
clone `--depth 1 --single-branch` and may delete and re-clone the directory on
every deploy. Both properties break it as a fetch source — no connecting history
to send, no merge base, and objects that vanish underneath clones made from it.

The general rule: if you fetch from a path someone else's tooling manages, you own
neither its history nor its lifetime. Either fetch from the real remote, or repair
the checkout automatically somewhere that re-runs on every deploy — a manual fix
in an ephemeral directory is undone by the next deployment. And when history is
unavailable, degrade explicitly: `--depth=1` for operations that only need the tip
(never on a full clone, which it would truncate), and a refusal that names the
cause for operations that need a merge base.

Corollary for error handling: `did not send all necessary objects` and
`revision walk setup failed` are git telling you the *remote* is shallow. Decode
plumbing errors like that into the actual cause — the raw text sent the first
investigation looking at the wrong repository.

## Two producers of the same output will disagree — and one of them caches

Spoken replies had two independent producers: `useVoice` for session activation
modes and a passive `VoiceTTSPlayer` for the rest. Each fetched the voice config
once at mount and never refreshed it, and each applied its own gate. The failure
was not subtle once it happened: replies were spoken after the user switched
speech off, and synthesized **twice** when both producers believed it was on. The
same reasoning applied to the control — the flag had a checkbox in Settings *and*
in the mic popover, so the two views drifted and the stale one won silently.

Two rules fall out. **One producer per output**: if a second component needs the
same behaviour under different conditions, widen the first one's condition instead
of cloning it. **One control per piece of live state**: configuration ("how it
works") belongs in Settings, activation ("is it on right now") belongs where the
user is acting, and only there.

## A cursor over streamed text loses whatever never reaches a render

The chat store clears `streamText` the moment a message finalizes, so tracking
"what has been spoken" as an offset into a snapshot of that text assumes every
delta is rendered. It isn't: a short reply arrives as a single delta, React batches
it with the finalize event, and the text goes from empty straight back to empty —
the whole reply is skipped. Key such cursors by the **message id** and let the
finalized message be the authority, with the stream only as an early-start
optimisation. Then a reply is handled exactly once whether it streamed over seconds
or landed in one frame.

## Debounced saves must accumulate, not replace

`VoiceTab`'s debounce restarted its 600 ms timer holding only the newest patch, so
changing two fields in quick succession persisted only the second — while the UI
kept showing the optimistic value for both. A setting that looks saved and isn't is
worse than one that fails loudly, and it is indistinguishable from the feature
ignoring the setting. Merge pending patches; flush the merged patch.

## An invariant between two flags belongs in one value

"Video means audio and video" is an invariant. Expressed as two booleans it is a
rule someone has to maintain at every write, and every unmaintained path produces a
state the product has no meaning for — a face on screen with the sound off. As one
value (`voiceOutput: "off" | "audio" | "avatar"`) the bad state is not
representable, the buttons become pure mappings between values, and there is
nothing to keep consistent.

Reach for this whenever two flags have an implication between them. The test is
whether you can write down a combination that "shouldn't happen": if you can, it
will, and it should not have been expressible.

## Liveness is something the renderer proves, not something a socket implies

An engine's audio sink swallows every utterance — BOS hands it the audio and
withholds local playback so nothing is said twice. That was gated on the plugin's
own "my WebSocket is open", and closing the avatar's window didn't close the socket,
so replies went to a face nobody could see: **a silent assistant, no error**.

The fix is a lease the renderer keeps renewing while it is actually rendering, which
expires on its own. Anything downstream requires a live lease, not a claim. When
some component's output can be *taken over* by another, don't ask the taker whether
it is ready — require continuous evidence, and make the fallback automatic when the
evidence stops. "Remember to release it" is not a design.

## Own the lifecycle where the thing is visible

The engine session used to start and end with the microphone, which was wrong in
both directions: deactivating the mic tore down a live avatar, and closing the
avatar left its connection up. It now begins and ends with the window that shows
the face — the surface that can actually appear and disappear.

Attach lifecycle to whatever the user can see and close, and let everything else
derive from it. Related: prefer letting the server resolve "which session is
current" from that state over having the client keep a copy that can go stale.

## Removing a facet removes every handle the UI had on the item

Making `live-avatar` plugin-only was right architecturally and broke three things
at once, all invisible from the diff: the Marketplace could no longer install it
(its installable-facet check knew `app`, `skill`, `services` and nothing else), it
appeared on no Settings page once installed (Settings → Apps lists apps; Settings →
Plugins is an unrelated registry), and it could not be uninstalled at all. The item
was installed, active and working — and looked, to the user, entirely absent.

An `app` facet had been doing double duty as the *handle*: the thing you install
through, see in a list, and remove. When you take a facet away, ask what UI was
reaching the item through it. And prefer capability checks that enumerate what
exists (`hasPluginFacet(item)`) over ones that hard-code the shapes someone
happened to think of first.

The general rule: **an item's management surface must not depend on it happening to
ship a window.** Install, list and uninstall are properties of an item, so they
belong on the item — one `install-item`, one `uninstall-item`, one scan that
answers "is this installed", each dispatching on the facets actually present.

## Keep mirrors in sync

`tool-manifest.ts` mirrors the registered actions (Tools panel). `specs/` mirrors
architecture. `docs/usage` + `docs/dev` (the source trees the in‑OS Docs app renders) mirror features for users and developers. Update all relevant mirrors
when you change behavior — and record intentional spec divergence in
`specs/discrepancies.md`.
