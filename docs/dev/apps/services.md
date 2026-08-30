# Service Daemons

Services are long-running background worker threads (WebSocket servers, pollers,
daemons) that install and manage like marketplace items but run continuously in
the same Node.js process as BOS. Spec: `user-specs/002-service-daemons`.

Related reading: [Architecture overview](../architecture-overview.md) ·
[Repository & data layout](../repository-and-data-layout.md) ·
[API reference](../api-reference.md) · [Plugin pipeline](../plugins/plugin-pipeline.md)
(the `hooks/` directory below).

---

## 1. When to build a service vs. an app

- **Built-in/installed app** — a UI surface the user opens and interacts with directly.
- **Service** — a background process the user starts once and mostly ignores; it
  exposes a port (or does polling/IPC work) that something else — an app, a script,
  the assistant — talks to. A service item MAY also bundle an `app/` (a thin UI
  that talks to its own service, e.g. the Terminal), but the service itself has no
  window.

If you just need OS state or a settings panel, don't build a service — use a
[built-in app](../guides/apps.md) or a [Settings tab](../configuration/configuration-system.md).

---

## 2. Item directory structure

Every service item — whether it lives in the user's own `user-apps/` GitFS
repo, is marketplace-sourced, or authored by hand — is a self-contained folder:

```
<item-id>/
├── services/
│   ├── service.json     # required — the manifest (see §3)
│   └── index.js         # required — the entry file named in service.json's `entry`
├── config/               # required (may be empty) — default config file(s)
│   └── <item-id>.json    # e.g. { "port": 3001, "host": "127.0.0.1" }
├── app/                  # optional — a bundled iframe UI (index.html)
├── spec/                 # optional — an adoptable spec template
├── doc/                  # optional — markdown surfaced in the Docs app
└── hooks/                # optional — CommonJS hook modules (see §8, currently inert)
```

`config/` must always exist (even empty) — installation fails otherwise.
`app/`, `spec/`, `doc/`, `hooks/` are all optional and skipped silently when absent.

---

## 3. The `service.json` manifest

```json
{
  "id": "terminal",
  "name": "Terminal Service",
  "version": "1.0.0",
  "description": "WebSocket-based terminal service for shell access",
  "entry": "index.js",
  "configSchema": {
    "type": "object",
    "properties": {
      "port": { "type": "number", "default": 0, "description": "WebSocket port — 0 lets the OS assign one automatically (recommended, see below)" },
      "shell": { "type": "string", "default": "/bin/bash", "description": "Shell executable" }
    }
  },
  "dependencies": [],
  "settingsRegistration": {
    "label": "Terminal",
    "icon": "terminal",
    "order": 100,
    "configApp": "terminal-config"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Must match the item's directory name — `installService()` rejects a mismatch. |
| `name`, `version` | yes | Free-form. |
| `entry` | yes | Path to the worker script, relative to `services/`. |
| `configSchema` | no | JSON Schema rendered by `ServiceConfigPanel`; also validated at install time. |
| `dependencies` | no | Array of other service ids that should start first (advisory, not blocking — see §7). |
| `settingsRegistration` | no | Metadata only today — `configApp` is not yet wired to a real component lookup. |
| `deploymentMode` | no | `"default"` (implicit) or `"tools"` — opts the service into exposing native assistant tools. See §15. |

### Choosing a port — default to `0`, always

**Default any configurable port in `configSchema` to `0`, not a fixed number.**
`0` means "the OS assigns a free ephemeral port" — `ServiceManager.ts` skips
its pre-start port check entirely for `0` and lets the worker's own
`http`/`ws` server bind whatever the OS hands back, then reports it via the
`bound` IPC message (below) into `runtime.json`. The OS's ephemeral range
(~32768-60999 on Linux) sits far above any port BOS itself ever uses, so `0`
is always safe — no explicit "avoid this range" logic is needed for it to
work correctly.

**A fixed, non-zero default is a real landmine, not a hypothetical:** the
Terminal service originally shipped with `"port": 3001` as its default — which
is the *first slot* of the Supervisor's own preview-worktree pool
(`BASE_PORT+1` through `BASE_PORT+POOL_SIZE`, i.e. **3001-3020** by default —
see §11). Any Dokploy/Bastion deployment building a feature-branch preview
while Terminal (or any other service defaulting into that range) is running
risks the preview allocator handing out a port the service already owns,
which then fails the preview build with a real `EADDRINUSE`. This wasn't a
one-off mistake either: BOS's own `probeOnce()` (the allocator's collision
check) only sent a plain HTTP GET — a raw TCP/WebSocket-only listener like
Terminal's accepts the connection but never answers HTTP, so the probe
mis-read "occupied" as "free." Both sides of this incident are now fixed
(Terminal's shipped default is `0`; `probeOnce()` now also tracks the raw TCP
`connect` event, not just an HTTP response), but the general lesson still
applies to any NEW service you write: **never give a configurable port a
fixed non-zero default.**

BOS's own reserved ports, which `src/core/service/PortChecker.ts`'s
`checkPortReservedByBos()` checks a fixed, non-zero configured port against
before ever spawning the worker (refusing to start with a clear, Settings-UI-
visible error if it collides, rather than failing silently or crashing):

| Deployment | Reserved | Source |
|---|---|---|
| Plain `npm run dev` | `3000` (Next.js's own port) | no Supervisor in front, so this is the only reservation |
| Supervisor-fronted (Dokploy, self-hosted Docker, Bastion) | The Supervisor's public port (`BOS_PUBLIC_PORT`, default `8080`, `8090` under Bastion) **+** the base-branch port and its preview pool (`BOS_PORT_BASE`..`BOS_PORT_BASE+BOS_PORT_POOL_SIZE`, default `3000-3020`) | `tools/supervisor/supervisor.mjs`'s `PUBLIC_PORT`/`BASE_PORT`/`POOL_SIZE` |

If you must use a fixed port for a real reason (rare — e.g. a protocol that
hardcodes a well-known port on the client side), document why in the item's
own `doc/`, and expect BOS to refuse to start the service if that port falls
inside the table above.

Validation lives in `src/core/service/manifestValidator.ts`:
`validateManifest()` (structural — required fields, self-dependency check, entry
existence if `itemDir` is passed) and `validateManifestAtStart()` (CH-011 —
actually `import()`s the entry from the **main thread**, where `parentPort` is
`null`, to catch load-time errors before a worker is ever spawned). See §6 for
the guard this requires in your worker script.

---

## 4. Install: symlink mapping

Installing a service (`src/system/marketplace/install/serviceInstaller.ts` +
`symlinkManager.ts`) does NOT copy the item anywhere — it creates ONE symlink
into wherever the item already lives (`dataDir()/user-apps/items/<id>/` or a
marketplace clone) and seeds that item's config:

```
dataDir()/system/<id>                 -> <itemPath>            (the whole item)
dataDir()/system/config/<id>/         =  a REAL directory, seeded from <itemPath>/config
```

Facets are then reached *through* that one link — `<id>/services/service.json`,
`<id>/app/`, `<id>/plugin/bos-plugin.json`, `<id>/spec/`, `<id>/hooks/` — found by
the shared depth-2 scanner (`src/system/items/installed.ts`). Before 035 there
were up to six symlinks per item, two of which (`specs/external-specs/<id>`,
`docs/external-docs/<id>`) had no readers at all.

`isInstalled(id)` is defined as "the `system/<id>` symlink exists."
Installation is atomic: if any step fails (bad manifest, id mismatch), the link is
removed again (`installItemLink()` / the installer's try/catch).

Config is the single copy that install performs, because it is mutable **state**:
the service writes `runtime.json` into it at start, and BOS stores capability
grants there. It must never live inside a read-only marketplace clone. It also
survives uninstall, so a reinstall keeps the user's settings.

Uninstalling reverses this: stop the service if running, remove every
symlink, unregister it — and that's it. **Uninstall never deletes the item's
source.** `dataDir()/user-apps/items/<id>/` is the user's own GitFS repo (the exact
same concept as `user-specs/` — BOS never populates or deletes from it, only
ensures it's a git repo), so install/uninstall are purely a matter of
creating/removing symlinks into whatever is already there. A marketplace
clone under `dataDir()/marketplace/<mktId>/items/<id>/` is equally untouched
by uninstall, regardless of which path the item was originally installed
from.

### Where an item can come from

| Source | How it gets into `user-apps/` | Discovered from |
|---|---|---|
| **The user's own repo** | The user clones/manages `dataDir()/user-apps/` themselves — BOS only runs `ensureRepo()` on it at boot (`src/instrumentation.ts`), a no-op if it's already a git repo | `dataDir()/user-apps/items/<id>/` |
| **Marketplace (adopted)** | `installMarketplaceService(marketplaceId, itemId)` (`src/lib/marketplace/client.ts`) symlinks the item at `data/system/<id>` — nothing is copied (035) and commits it (mirroring `adoptSpec()`'s fork-and-commit), then calls `installService()` | Marketplace clone at `dataDir()/marketplace/<mktId>/items/<itemId>/`, or the resulting `user-apps/items/<id>/` copy |
| **Hand-authored** | Place the folder directly under `dataDir()/user-apps/items/<id>/` | Same |

`ServiceRegistry.discoverServices()` scans both `user-apps/` and
`marketplace/<id>/items/` for a `services/service.json` — that's how an item
shows up in **source state** (installable) before it's ever installed.

> **`dataDir()/user-apps/` is itself a marketplace** — structurally identical to
> any registered clone: a root `marketplace.json` plus items under `items/<id>/`
> (`034-user-apps-marketplace-parity`). It occupies the local slot keyed by
> `LOCAL_MARKETPLACE_ID` ("user-apps"), which identifies a **location**, not the
> repo's identity; the displayed id/name come from its own manifest.
>
> BOS **maintains** that manifest (`reconcileLocalManifest()` in
> `src/lib/marketplace/client.ts`), reversing the earlier rule that it must never
> write into this repo. It writes only `marketplace.json`, only by **merge** —
> add newly discovered `items/` directories, prune vanished ones, never touch a
> field it did not author — and only when the serialized result differs from
> what's on disk, so a catalog read never dirties a repo the user may be tracking
> against a remote. Auto-discovery is preserved: dropping a folder into `items/`
> makes it installable with no manual manifest editing.
> `installMarketplaceService()` special-cases this id to skip its normal copy
> step (source and destination would otherwise be the same directory — `fs.cp`
> refuses to copy onto itself). The Marketplace app renders it as a "My Apps"
> section with `app`/`services`/`spec` badges, same as any registered
> marketplace. A single **"Install"** button installs every facet an item
> offers in one click (`src/apps/marketplace/index.tsx`'s `installItem()`) —
> an item is one thing, even when it bundles both a service and an app.
> `dataDir()/user-apps/` also shows up as its own "User Apps" entry in
> Settings → Versions (`src/lib/gitops/filesystems.ts`), same as any other
> GitFS instance — the user can inspect its history or push/pull a remote
> from there.

---

## 5. Registry: source vs. installed state

`src/core/service/ServiceRegistry.ts` is a `globalThis`-backed singleton (survives
Next.js dev-mode hot reload) that distinguishes:

- **Source state** — an item with a valid `services/service.json` under
  `user-apps/items/` or `marketplace/<id>/items/`, discovered but not installed (no `data/system/<id>` link).
- **Installed state** — the `system/<id>` item symlink exists and the item has a `services/` facet; the service
  has full runtime state (`state`, `worker`, `restartCount`, `boundPort`/`boundHost`).

`getAllServices()` merges both; a service can appear in source state without
being installed. Registry events (`service:status:changed`, `service:bound`,
`service:crash`, `service:installed`, `service:uninstalled`) are buffered
(replay-on-subscribe, same pattern as the assistant's run-event stream) and
exposed over `GET /api/services/events` as NDJSON.

---

## 6. Lifecycle: worker threads + IPC

Services run as `worker_threads` — not child processes, not containers — with
`resourceLimits` (`maxOldGenerationSizeMb: 256`, `maxYoungGenerationSizeMb: 64`)
managed by `src/core/service/ServiceManager.ts`.

**Main → worker**: `{ type: "initialize", configDirPath, logsPath, serviceId }`,
`{ type: "dispose" }`, `{ type: "restart", reason }`, `{ type: "tool_call", payload }`
(only for a `deploymentMode: "tools"` service — see §15).

**Worker → main**: `{ type: "initialized" }`, `{ type: "bound", port, host }`,
`{ type: "error", message, stack? }`, `{ type: "disposed" }`,
`{ type: "log", level, message }`, `{ type: "crash", error, stack? }`,
`{ type: "tool_declare", payload }`, `{ type: "tool_result", payload }`,
`{ type: "tool_error", payload }` (§15).

Your worker script (the `entry` file) MUST:

```js
const { parentPort } = require("worker_threads");

// Every top-level use of parentPort MUST be guarded — this same file is
// import()ed from the MAIN thread (parentPort === null) by
// validateManifestAtStart's CH-011 load check. An unguarded top-level call
// throws there and fails manifest validation before a worker ever spawns.
if (parentPort) {
  parentPort.on("message", async (msg) => {
    if (msg.type === "initialize") {
      // read msg.configDirPath + "/" + msg.serviceId + ".json", bind, etc.
      parentPort.postMessage({ type: "initialized" });
      parentPort.postMessage({ type: "bound", port, host }); // CH-005
    } else if (msg.type === "dispose") {
      // close everything
      parentPort.postMessage({ type: "disposed" });
    }
  });
}
```

See §12 below for a complete real example (WebSocket server + per-connection
shell via `child_process.spawn`).

**Config vs. runtime state**: user-editable values live in
`dataDir()/config/<id>/<name>.json` (any number of files, item-defined). The
service manager writes the *actual* bound port/host to a separate
`dataDir()/config/<id>/runtime.json` after the worker's `bound` message — this
keeps "what the user asked for" (e.g. `port: 0` for "assign me anything")
separate from "what actually happened." `GET /api/services/<id>/config`
returns both; `PATCH` only ever touches the named user config file (never
`runtime.json`, which is rejected as a reserved name).

**Crash recovery** (`src/core/service/CrashRecovery.ts`): exponential backoff
(`backoffMs * backoffMultiplier^(restartCount-1)`, defaults 1s/2s/4s/8s/16s),
`restartCount <= maxRestarts` (default 5) before giving up. Crash is detected via
the worker's own `crash` message OR the Worker object's `exit`(non-zero)/`error`
events — a worker that dies before ever sending `initialized` still triggers
recovery.

**Timeouts**: startup/shutdown waits are configurable (`startupTimeout`/
`shutdownTimeout` on the start/stop API calls), default 30s; `0` disables
waiting. On timeout the worker is force-`terminate()`d and it's logged.

> **Gotcha:** `next dev`'s Turbopack bundler intercepts every literal `new
> Worker(...)` call site and tries to statically resolve its argument as a
> bundlable module. Since `entryPath` here is computed at runtime (a
> user-installed item's script, outside the bundle), this fails at runtime
> with `Cannot find module 'unknown'` — caught by the surrounding try/catch,
> so the service just silently stays `"stopped"` with no obvious error unless
> you check the logs. `/* webpackIgnore */`/`/* turbopackIgnore */` comments
> do **not** suppress this (unlike for `import()`/`require()`). `ServiceManager.ts`
> works around it by building the call via `new Function(...)` so the literal
> `new Worker(` text never appears for Turbopack's parser to see
> (`createNodeWorker`). This is invisible to the Playwright unit test suite,
> which runs in plain Node — always verify a worker actually reaches
> `"running"` via a live `npm run dev` + real API call, not just unit tests.
> See [Design heuristics](../design-heuristics.md).

---

## 7. Dependencies & startup order

`src/core/service/DependencyResolver.ts` topologically sorts `dependencies` from
each installed service's manifest. Failure handling is deliberately lenient
(CH-007): a missing/failed dependency is logged at `warn` and does **not** block
the rest of `startAll()` from proceeding — except that a dependent service is
skipped (crash-loop prevention, CH-003) if its declared dependency is not
currently `running`. Circular and missing dependencies are detected and logged,
never thrown. Self-dependencies are rejected at install time.

A dependent service discovers its dependency's actual binding by reading the
dependency's `dataDir()/config/<depId>/runtime.json` — not IPC, not a shared
registry call.

---

## 8. The optional `hooks/` directory (currently inert)

A service item may ship a `hooks/` directory; `symlinkManager.ts` creates
`dataDir()/system/hooks/<id>` for it. **Nothing consumes that symlink today.**
The spec's intent (FR-034–FR-037) is for service hooks to register via a future
`registerHook()`/`hook.json`, once the existing plugin pipeline
(`src/lib/plugins/*`, `registerPlugin()`/`plugin.json`) is renamed from
"plugins" to "hooks." That rename hasn't happened — see
[Plugin pipeline](../plugins/plugin-pipeline.md) for what exists today. Until
then, a service's `hooks/` directory is symlinked but functionally a no-op.

---

## 9. Settings UI

Services live in **Settings → Plugins**, below the Plugin Pipeline list (FR-028):

- `src/components/apps/settings/PluginsTab.tsx` hosts both the plugin list and,
  in the same left sidebar, `ServicesTab.tsx`.
- `ServicesTab.tsx` lists installed services, live-updated via
  `GET /api/services/events` (NDJSON, replay + tail).
- `ServiceCard.tsx` — Start/Stop/Restart buttons (gated by current state),
  Config/Logs buttons, and an "Open App" button (opens `/apps/<id>/`, served
  through the item's `data/system/<id>` item symlink; 404 if the item has no
  `app/`).
- `ServiceConfigPanel.tsx` — renders `configSchema`-driven fields per config
  file, auto-saves via `PATCH /api/services/<id>/config` (no Save button, FR-032).
  Read-only when the item's source is a marketplace clone.
- `ServiceLogViewer.tsx` — tails `dataDir()/logs/services/<id>.log`.

---

## 10. API routes

| Route | Methods | Purpose |
|---|---|---|
| `/api/services` | GET, POST, DELETE | List all (source + installed); install (`{ itemPath, serviceId }`); uninstall (`{ serviceId }`) |
| `/api/services/[id]` | GET, POST | Detail (incl. `corruptedReason`); lifecycle action `{ action: "start"\|"stop"\|"restart", reason?, startupTimeout?, shutdownTimeout? }` |
| `/api/services/[id]/config` | GET, PATCH | List config files + `runtime.json` + `readOnly`; auto-save patch `{ file, patch }` (rejects `file === "runtime"`) |
| `/api/services/[id]/logs` | GET | Log file content |
| `/api/services/events` | GET | NDJSON `ServiceRegistryEvent` stream, `?since=<seq>` replay |

---

## 11. Reaching a service from outside the container (read this before designing any service with its own network port)

**A service's own network port is never directly reachable once BOS is
deployed behind a reverse proxy** (Traefik/nginx/etc. — e.g. Dokploy, or the
multi-user Bastion) — only the Supervisor's own public port
(`BOS_PUBLIC_PORT`, e.g. `8090`) is exposed/TLS-terminated there. This is true
for every deployment except plain local `npm run dev` with no Supervisor in
front, where direct `host:port` access happens to work because nothing sits
between the browser and the service.

**Do not conclude from this that the service needs to move inside Next.js**
(e.g. `src/middleware.ts`, an API route). Next.js's App Router only dispatches
a fixed, standard set of HTTP methods — it cannot express a protocol like
WebDAV's `PROPFIND`/`MKCOL`/`COPY`/`MOVE` at all. The fix is not "run inside
Next.js instead of as a service"; it's "reach the service's own port through
the Supervisor," which already forwards arbitrary methods/paths untouched.

**There is no mechanism anywhere in BOS where a service is exposed WITHOUT
binding a real port.** Every worker-thread service that handles network
requests binds an actual TCP port and reports it via the `{ type: "bound",
port, host }` IPC message (§6) — that bound port is the only thing the
Supervisor has to forward to; there is no alternate "portless" or
"path-proxy" routing that hands a raw request straight to a worker without it
owning a listening socket. If you (or a design you're revising, or a
correction someone else asked you to apply) ever concludes a service "doesn't
need to bind a port" or "is exposed entirely via proxy with no port," that
conclusion is wrong, not a simplification — go re-read this section and §6
before writing it down.

### The mechanism

The Supervisor (`tools/supervisor/supervisor.mjs`) is the one process bound to
the public port in every Docker/Bastion deployment, so it's the layer that can
proxy through to a service's actual (dynamically-assigned) port — resolved
per-request from the pinned version's own
`dataDir()/system/config/<id>/runtime.json` (written by `ServiceManager.ts`
after the service's `bound` IPC message), so a preview's own services are
reached, not always base's:

- **WebSocket traffic** (e.g. Terminal's shell socket) — handled on the
  `server.on("upgrade", ...)` event; `proxyServiceUpgrade()` matches
  `/__supervisor/services/<id>/ws` and forwards the upgrade handshake.
- **Plain HTTP traffic** (anything else — including non-standard methods a
  Next.js route handler can't express) — handled on the regular request path;
  `proxyServiceHttp()` matches `/__supervisor/services/<id>(/...)` and
  forwards the request as-is (method, headers, body, and the remainder of the
  path after the `<id>` segment) to `127.0.0.1:<port>`.

Both are exposed to the client the same way: `GET /api/services/<id>/config`
(`src/app/api/services/[id]/config/route.ts`) returns `wsPath` and `httpPath`
fields whenever `supervisorEnabled()` is true (both `null` under plain
`npm run dev`, where the client should fall back to direct `host:port`):

```json
{ "wsPath": "/__supervisor/services/<id>/ws",
  "httpPath": "/__supervisor/services/<id>/" }
```

(`<service-id>` is a placeholder for illustration only — substitute the real
`service.json` id, e.g. `terminal`. Never copy a literal example id from this
doc into a real design as if it were a fixed, meaningful path segment.)

Client pattern — prefer the server-provided path when present, fall back to
direct `host:port` only when it's absent:

```js
const wsUrl = data.wsPath
  ? `${wsScheme}//${location.host}${data.wsPath}`
  : `${wsScheme}//${location.hostname}:${runtime.port}`;

const httpBaseUrl = data.httpPath
  ? `${location.origin}${data.httpPath}`
  : `${location.protocol}//${location.hostname}:${runtime.port}/`;
```

**Any new service with its own network port — WebSocket or plain HTTP — must
follow this `wsPath`/`httpPath`-if-present-else-direct-port pattern.** Never
hardcode or guess a public URL for a service (e.g. assuming a specific reverse
proxy path exists without checking this doc/code) — that produces a URL that
looks plausible and passes typecheck but 404s for real users.

### The three deployment scenarios, spelled out literally

A design/mockup that shows the user a connection URL (e.g. a WebDAV client's
"server address" field) must describe ALL THREE of these — not just whichever
one you tested against — since which one applies is a deployment fact, not a
choice the service gets to make:

| Scenario | Client-facing HTTP base URL | Where it comes from |
|---|---|---|
| **Multi-user Bastion** (reverse-proxied, e.g. production) | `https://<external-hostname>/__supervisor/services/<service-id>/` | `<external-hostname>` is whatever domain the operator's own reverse proxy (Traefik/nginx/Bastion) terminates TLS on and forwards to the container's `BOS_PUBLIC_PORT` (`8090`, set by `bastion/src/docker.ts`) — that internal port is never itself part of the client-facing URL; the operator's front door decides the externally visible host/port (typically standard `443`). |
| **Supervisor only, no Bastion** (e.g. a single-user Docker/Dokploy deployment fronted directly by the Supervisor) | `http://<hostname>:<public-port>/__supervisor/services/<service-id>/` | `<public-port>` is `BOS_PUBLIC_PORT` if the operator set it (Bastion-style deployments set `8090`), otherwise the Supervisor's own code default, **`8080`** (`tools/supervisor/supervisor.mjs`'s `PUBLIC_PORT = process.env.BOS_PUBLIC_PORT \|\| 8080`) — always confirm which one a given deployment actually set rather than assuming either number. |
| **Standalone, no Supervisor at all** (plain `npm run dev`/`next start`) | `http://localhost:<runtime-port>/` | `wsPath`/`httpPath` are both `null` here (`supervisorEnabled()` is false), so the client falls back to `location.hostname:runtime.port` — `<runtime-port>` is whatever the OS assigned this run (e.g. `http://localhost:44231/`, illustrative only), read from `GET /api/services/<id>/config`'s `runtime.port` field. **This is never a fixed number** — a service defaulting its port to `0` (as it should — see §3) gets a different OS-assigned port every restart; don't write a specific port into a mockup or design as if it were stable. |

### Multi-user (Bastion) auth composes for free — IF your token is registered

In a Bastion deployment, a non-browser client (a WebDAV client, `curl`, etc.)
can't hold a session cookie. Bastion's headless Basic-auth credential routing
(034-secrets-authentication, `bastion/src/proxy.ts`) already handles this: it
resolves the presented secret to a specific user's container and rewrites the
request to a `Bearer` credential before forwarding — by the time the request
reaches the Supervisor, it's already routed to the right user.

**This only works if your service's token was minted via `createSecret()`**
(`src/lib/secrets/service-secrets.ts`), because that's the ONLY thing that
writes the companion `credentials-index.json` entry Bastion's routing
consults. A service that hand-rolls its own token generation/hashing
entirely in worker-thread code — which used to be this doc's own
recommendation, since a worker thread can't `import` `service-secrets.ts`
directly — never registers anything there, so Bastion rejects every request
at the front door before it ever reaches the service's own check, no matter
how correct that check is. This happened for real, to a shipped WebDAV
service.

The fix is the same loopback-bridge pattern as VFS access, not a
self-contained token scheme: see
[Headless-client auth](../features/headless-client-auth.md)'s "Worker-thread
services" section for the exact `/api/secrets/<service>` (mint/list/revoke,
browser-initiated) and `/api/secrets/<service>/verify` (loopback, called by
the worker on every request) routes to use instead. With that in place,
nothing additional is needed at the Bastion layer for a new service beyond
the Supervisor-level `wsPath`/`httpPath` proxying above.

---

## 12. Worked example: a Terminal service

A minimal illustrative shape — a WebSocket shell daemon plus its own bundled
UI, the same kind of item you'd place in your own `dataDir()/user-apps/`:

```
terminal/
├── services/
│   ├── service.json    # id: "terminal", entry: "index.js"
│   └── index.js        # WebSocketServer + one child_process shell per connection
├── config/
│   └── terminal.json   # { "port": 3001, "host": "127.0.0.1", "shell": "/bin/bash" }
└── app/
    └── index.html       # self-contained UI: fetches its own config, opens a WS
```

The bundled `app/index.html` fetches `GET /api/services/terminal/config` to
learn the (possibly runtime-reassigned) port/host. Installed from the LOCAL
marketplace (user-apps/items/), the app runs same-origin (origin `"local"`), so a
direct `fetch()` works; it falls back to the iframe SDK broker
(`services:read`) when running opaque-origin (installed from a remote
marketplace). It then connects:

```js
const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = data.wsPath
  ? `${wsScheme}//${location.host}${data.wsPath}`   // Supervisor-managed: proxied
  : `${wsScheme}//${location.hostname}:${runtime.port}`; // plain `npm run dev`: direct
```

— preferring the server-provided `wsPath` (present whenever
`supervisorEnabled()` is true, i.e. any Docker deployment) over a direct
connection to its own port, since that port generally isn't reachable once
deployed behind a reverse proxy (§11, which also covers the plain-HTTP
`httpPath` case for a service that isn't a WebSocket). Any service with its
own network port should follow this same pattern.

BOS itself doesn't ship this item — `dataDir()/user-apps/` is the user's own
GitFS repo (§4), so there's nothing built in to seed. `tests/services/`'s
fixtures (`_worker-fixtures.ts` and `layOutItem()`/`layOutServiceAndApp()`
helpers in the integration/local-marketplace test files) construct a synthetic
item with this exact shape to exercise the real install/uninstall/registry
flow end to end — read those if you want a runnable reference to copy from.

---

## 13. Testing

Unit/integration tests for services live under `tests/services/` and run on
**Playwright's test runner** in Node mode (not a browser) —
`npx playwright test -c playwright.unit.config.ts tests/services/`. Conventions:
`useTestDataDir(label)` (fresh temp `BOS_DATA_DIR`), `resetServiceSingletons()`
(clears the `globalThis` registry/manager), real (unmocked) `fs`/`worker_threads`
with small fixture worker scripts (`_worker-fixtures.ts`). `integration.test.ts`
specifically exercises the real `installItemLink`/`installService`/
`uninstallService` functions end-to-end, not the registry's
`registerInstalled()` shortcut the other unit tests use.

`validateManifestAtStart(manifest, serviceDirPath)` takes the service's **own**
directory and resolves `<serviceDirPath>/<entry>`. Before 035 it took a shared
root and joined `manifest.id` onto it, mirroring the old
`dataDir()/system/services/<id>` symlink farm — so if you find older code or notes
passing a parent directory, that is the reason. There is no farm now: the
installer passes `dataDir()/system/<id>/services`.

> **Green tests are not proof the feature works.** The unit suite runs plain
> Node against `serviceRegistry()`/`serviceManager()` directly — it never goes
> through `instrumentation.ts`'s boot hook, never runs under Turbopack, and
> never touches the iframe sandbox. All tests were passing while (a)
> the boot hook had never actually run once in the real app (see
> [Design heuristics](../design-heuristics.md)) and (b) `new Worker(entryPath)`
> was silently failing under `next dev`. Both were only caught by starting
> `npm run dev` and driving the real HTTP API end to end (`POST
> /api/services/<id>` with `{action:"start"}`, then checking `state ===
> "running"` and actually connecting to the bound port). Do this after
> touching anything in this doc's §4/§6 — don't stop at green tests.

---

## 14. Known limitations

- No CPU isolation between services (memory-isolated via separate V8 heaps only;
  a CPU-bound worker can still starve BOS and other services).
- No container-based services (Docker) — worker threads only, for v1.
- No port auto-retry — a configured port already in use is a hard failure; the
  user must change it in Settings.
- No direct function exports from a service — everything is the `postMessage`
  IPC protocol in §6 (native tool exposure, §15, is no exception — a tool call
  is still `tool_call`/`tool_result`/`tool_error` over the same channel, just a
  message shape the kernel treats specially).
- `hooks/` is inert (§8).
- A service's bundled `app/` runs like any other installed app once installed
  through the Marketplace — including the `marketplace`-origin opaque sandbox.
  If it needs to talk to its own service (or any BOS API), it must go through
  the `window.__bos` broker with a granted capability, not a direct `fetch()`
  — see
  [Design heuristics](../design-heuristics.md#opaque-origin-sandboxed-apps-cant-fetch-bos-apis-directly)
  and [Apps guide](../guides/apps.md#trust-tiers-the-sdk--sandbox-028). The
  user must explicitly grant that capability in Settings → Apps after
  installing — it is never granted automatically. Three broker methods share
  the `services:read` capability: `services.getConfig(id)` (config files +
  runtime state, e.g. the bound port), `services.status(id)` (`{ service:
  { state, boundPort, ... } }` — is it actually running), and `services.call(id,
  path, init?)` (proxy an HTTP call to the service's own REST bridge — the
  ONLY way an opaque-origin app's bundled UI can actually invoke its service's
  API, not just read its config; resolves the same `wsPath`/`httpPath`-if-
  present-else-direct-port base as `getConfig`/§11, then performs the real
  request from the trusted parent frame and relays the parsed JSON body back).
  A companion app should try a direct same-origin `fetch()` first (works when
  installed "local") and fall back to these broker methods on failure —
  see `bridge.ts` in the `workflows` marketplace item for a worked example.
- `settingsRegistration.configApp` is metadata only — there's no registry that
  resolves it to an actual React component; every service uses the generic
  `ServiceConfigPanel` today.

---

## 15. Services as native assistant tools (`deploymentMode: "tools"`, 039-service-tool-exposure)

A service can expose one or more agent-callable tools **without standing up an
MCP server** — the tools surface as ordinary `AssistantTool` entries
(`execution: "server"`) alongside every built-in, gated by the exact same
allowlist/deferred rules. Spec: `user-specs/039-service-tool-exposure`
(FR-001–FR-010 below). This is opt-in and fully backward compatible: a service
that never sets `deploymentMode` behaves exactly as in §1–§14.

### Opting in (FR-010)

Set `"deploymentMode": "tools"` in `service.json` (§3). Anything else, or the
field's absence, means `"default"` — no tools, current behavior. Validated by
`src/core/service/manifestValidator.ts` (enum `"default" | "tools"`; an
unrecognized value is rejected at install/start).

### Declaring tools — `tool_declare` (Worker→Main, FR-001)

After sending `{ type: "initialized" }`, a `"tools"`-mode worker posts one
`tool_declare` message per tool it wants to expose:

```js
parentPort.postMessage({
  type: "tool_declare",
  payload: {
    callId: "declare-my_tool",
    declaration: {
      name: "my_tool",
      description: "What this tool does, for the model.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
});
```

`ServiceManager.handleWorkerMessage` (`src/core/service/ServiceManager.ts`)
checks the service's own manifest: if `deploymentMode !== "tools"`, the
declaration is rejected and logged (`tool_declare:rejected`) — a service
can't grant itself tools by simply sending the message. Otherwise it calls
`serviceToolBridge().registerTool(serviceId, declaration)`
(`src/lib/agent/service-tool-bridge.ts`), which:

- validates the shape (`name`, `description` present; `inputSchema` compiles
  as a JSON Schema via Ajv — the same `new Ajv({ strict: false })` config
  `manifestValidator.ts` already uses) and rejects/logs a malformed
  declaration or an exact `serviceId:name` duplicate without registering it;
- stores the tool keyed `serviceId:name` and bumps an internal `version`
  counter so `src/lib/assistant/registry.ts`'s `assistantTools()` cache
  re-composes on the very next call (no stale-cache window);
- registers a **capability descriptor** with `src/lib/agent/
  capabilities-registry.ts`'s `registerAdditionalCapabilities()`, under the
  `"Service Tools"` group, using **the tool's own name as the capability id**
  (not a namespaced id) — this is what makes gating (below) actually apply to
  a live tool, not just to a hand-simulated one in a test.

Declarations are static per process — a service declares its tools once at
startup; there is no mechanism to add/remove a tool without restarting the
service (spec assumption, v1).

### Registry surfacing (FR-002)

`src/lib/assistant/registry.ts`'s `assistantTools()` merges every bridge-
registered tool in ahead of the static tool tables, but **a built-in always
wins a name collision** (service tools are spread first, built-ins after) —
a service cannot shadow an existing tool by declaring the same name.

### Invocation — `tool_call` / `tool_result` / `tool_error` (Main→Worker /
Worker→Main, FR-003, FR-008)

When the agent loop dispatches a call to a service tool (`runServerTool` in
`src/lib/assistant/agent-loop.ts`, same code path as every other server
tool), the generated `execute` hands off to
`serviceToolBridge().invoke(serviceId, name, args, signal)`, which:

1. **Validates `args` against the tool's compiled `inputSchema` first**
   (FR-004) — a failing validation returns an in-band error string
   immediately and **never sends a `tool_call`** to the worker at all (the
   worker never even sees the malformed call).
2. On valid args, dispatches through a `ToolDispatcher` that `ServiceManager`
   wires into the bridge at module load: `sendToolCall`/`waitForToolResult`
   in `src/core/service/workerIpc.ts` post a `{ type: "tool_call", payload:
   { callId, name, args } }` and wait for the **matching `callId`** on a
   `tool_result`/`tool_error` reply — concurrent calls never cross-talk
   because each waits on its own `callId`, not a bare message-type match.
3. The worker answers `{ type: "tool_result", payload: { callId, result } }`
   on success or `{ type: "tool_error", payload: { callId, error: { code,
   message, stack? } } }` on failure; either resolves the pending waiter.

The v1 transport is worker IPC only (`ServiceTool.transport === "worker-ipc"`
in `src/core/service/serviceToolTypes.ts`); a `"loopback-http"` transport
value is reserved in the type for a future child-process backend but has no
route wired up in v1 (FR-008's backend-agnostic contract is the type, not a
shipped HTTP path).

### Gating — allowlist + deferred, exactly like a built-in (FR-005)

Service tools are governed by **the same two gates** as every built-in:
- **Allowlist** (`agent.tools`) — an agent must explicitly list the tool's
  name to see it.
- **Deferred discovery** — a service tool can be hidden until revealed by a
  prior `find_tools` call in the same conversation, same as any built-in.

This works because `src/lib/assistant/gate.ts` (`gateFromAgent`, per-call)
and `src/lib/agent/tool-gate.ts` (`withToolGate`'s `transformParams`,
re-derived **per model step**, not a module-level constant) both source their
`registryIds` from `listCapabilities()` — which includes every dynamically
registered capability, not just the static `CAPABILITIES` table. **This is
why `registerTool` above also calls `registerAdditionalCapabilities()`**: a
tool name that never lands in `listCapabilities()` falls into
`tool-gate.ts`'s "not in the registry ⇒ always allowed" branch (the same
branch that lets non-registry things like consent/AGUI tools always pass
through) and would bypass allowlist/deferred gating entirely, regardless of
the agent's configuration. The capability id **must** equal the tool's
model-facing name (not a namespaced id) for this to line up — see
`tests/services/tool-integration.test.ts`'s "a real worker's declared tool is
gated by allowlist exactly like a built-in" test for the end-to-end proof
(unlike `tests/services/gate.test.ts`/`tool-gate.test.ts`, which register the
capability by hand to unit-test the gate logic in isolation).

Two different services may independently declare a tool of the same name;
`unregisterTool`/`unregisterServiceTools` only drop the shared capability
descriptor once **no** registered service tool still needs it, so one
service stopping never silently un-gates another's still-running tool of the
same name.

### Lifecycle cleanup (FR-006)

`ServiceToolBridge.unregisterServiceTools(serviceId)` — removing every tool
(and, per above, any capability descriptor no longer needed) the service
owns — is called from:
- `ServiceManager.stop()`, before the worker is torn down;
- the crash path (`src/core/service/CrashRecovery.ts`'s unexpected-`exit`
  handling) — a crash unregisters immediately; a subsequent restart
  re-declares and re-registers via a fresh `tool_declare`;
- `service:uninstalled` (emitted by `src/system/marketplace/install/
  serviceInstaller.ts`'s uninstall orchestration).

Because `assistantTools()` re-composes lazily off the bridge's `version`
counter, a **new** run started after unregistration never sees the removed
tool. A run already **in flight** snapshotted its own `tools` map at start
(`Object.assign(run.tools, assistantTools())` in
`src/lib/assistant/start-run.ts`) and keeps dispatching against that
snapshot for the rest of the run — a call to a since-stopped tool within that
same run degrades to an in-band tool error (next section), not a crash and
not silently ignored.

### Errors are always in-band, never a crash (FR-007)

A `tool_error` from the worker, an IPC-level failure (timeout, or the worker
exiting mid-call), or a kernel-side schema rejection (FR-004) all end up as a
thrown `Error` from `ServiceToolBridge.invoke()` — `runServerTool` (agent-
loop.ts) already converts any server-tool exception into an in-band `Error:
<tool>: <message>` string returned to the model. BOS itself never crashes and
the run continues.

### Trust (FR-009)

The worker-IPC transport is trusted by construction: only `ServiceManager`
holds the `Worker` reference, and only BOS ever posts a `MainToWorkerMessage`
to it — there is no path for anything outside BOS to send a `tool_call`. The
reserved `"loopback-http"` transport (above) would be gated by
`isLoopbackOnly()` (`src/lib/secrets/auth-scope.ts`), the same boundary
`/api/secrets/[service]/verify` uses, if/when it's actually wired up.

### Key files

| Path | Role |
|---|---|
| `src/core/service/serviceToolTypes.ts` | Framework-free types: `ToolDeclaration`, `ServiceTool`, `ToolInvocation`/`ToolInvocationResult`, the `services.tool-bridge` log component constant. |
| `src/lib/agent/service-tool-bridge.ts` | `ServiceToolBridge` — register/unregister/invoke, Ajv validation, capability-registry sync, structured logging. |
| `src/core/service/workerIpc.ts` | `sendToolCall`/`waitForToolResult` — `callId`-keyed dispatch and timeout/cancellation. |
| `src/core/service/ServiceManager.ts` | `tool_declare` handling (opt-in check), lifecycle wiring (register on declare, unregister on stop/crash/uninstall), the `ToolDispatcher` wired into the bridge. |
| `src/core/service/manifestValidator.ts` | `deploymentMode` schema validation. |
| `src/lib/assistant/registry.ts` | Merges bridge-registered tools into `assistantTools()`. |
| `src/lib/assistant/gate.ts`, `src/lib/agent/tool-gate.ts` | Source `registryIds` from `listCapabilities()` so dynamically-registered tools are gated like built-ins. |
| `tests/services/_tool-service-fixtures.ts`, `tests/services/_worker-fixtures.ts` (`TOOL_DECLARING_WORKER`) | Shared stub service (declares `echo_tool`) reused by unit, integration, and e2e tests. |
| `e2e/039-service-tool-exposure.spec.ts` | End-to-end self-test: install → start → the assistant calls the declared tool → the real result comes back. |

### FR → implementation quick reference

| FR | Covered by |
|---|---|
| FR-001 (declare at startup) | `tool_declare` handling, `ServiceManager.ts` |
| FR-002 (surface into `AssistantTool` registry) | `registry.ts`'s `assistantTools()` merge |
| FR-003 (invoke, get a result) | `workerIpc.ts` + `service-tool-bridge.ts`'s `invoke()` |
| FR-004 (schema validation before dispatch) | `service-tool-bridge.ts`'s Ajv check in `invoke()` |
| FR-005 (gated like a built-in) | `registerAdditionalCapabilities()` in `registerTool`/`unregisterTool` + `listCapabilities()`-sourced `registryIds` in `gate.ts`/`tool-gate.ts` |
| FR-006 (removed on stop/uninstall) | `unregisterServiceTools()` called from `stop`/crash/`service:uninstalled` |
| FR-007 (errors in-band, no crash) | thrown `Error` from `invoke()` → `runServerTool`'s existing catch-all |
| FR-008 (IPC contract, backend-agnostic) | `tool_call`/`tool_result`/`tool_error` message types + reserved `"loopback-http"` transport value |
| FR-009 (trust boundary) | worker-IPC trusted by construction; `isLoopbackOnly()` reserved for the HTTP transport |
| FR-010 (manifest opt-in) | `deploymentMode` in `manifestValidator.ts` |
