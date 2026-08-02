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
`{ type: "dispose" }`, `{ type: "restart", reason }`.

**Worker → main**: `{ type: "initialized" }`, `{ type: "bound", port, host }`,
`{ type: "error", message, stack? }`, `{ type: "disposed" }`,
`{ type: "log", level, message }`, `{ type: "crash", error, stack? }`.

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
  IPC protocol in §6.
- `hooks/` is inert (§8).
- A service's bundled `app/` runs like any other installed app once installed
  through the Marketplace — including the `marketplace`-origin opaque sandbox.
  If it needs to talk to its own service (or any BOS API), it must go through
  the `window.__bos` broker with a granted capability (e.g. `services:read`),
  not a direct `fetch()` — see
  [Design heuristics](../design-heuristics.md#opaque-origin-sandboxed-apps-cant-fetch-bos-apis-directly)
  and [Apps guide](../guides/apps.md#trust-tiers-the-sdk--sandbox-028). The
  user must explicitly grant that capability in Settings → Apps after
  installing — it is never granted automatically.
- `settingsRegistration.configApp` is metadata only — there's no registry that
  resolves it to an actual React component; every service uses the generic
  `ServiceConfigPanel` today.
