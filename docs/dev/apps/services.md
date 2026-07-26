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
      "port": { "type": "number", "default": 3001, "description": "WebSocket port" },
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

Validation lives in `src/core/service/manifestValidator.ts`:
`validateManifest()` (structural — required fields, self-dependency check, entry
existence if `itemDir` is passed) and `validateManifestAtStart()` (CH-011 —
actually `import()`s the entry from the **main thread**, where `parentPort` is
`null`, to catch load-time errors before a worker is ever spawned). See §6 for
the guard this requires in your worker script.

---

## 4. Install: symlink mapping

Installing a service (`src/system/marketplace/install/serviceInstaller.ts` +
`symlinkManager.ts`) does NOT copy the item anywhere — it creates symlinks from
`dataDir()/system/` and `dataDir()/config/` into wherever the item already lives
(`dataDir()/user-apps/<id>/` or a marketplace clone):

```
dataDir()/system/services/<id>        -> <itemPath>/services   (required)
dataDir()/config/<id>                  -> <itemPath>/config     (required)
dataDir()/system/app/<id>             -> <itemPath>/app        (optional)
dataDir()/specs/external-specs/<id>   -> <itemPath>/spec       (optional)
dataDir()/docs/external-docs/<id>     -> <itemPath>/doc        (optional)
dataDir()/system/hooks/<id>           -> <itemPath>/hooks      (optional, inert — §8)
```

`isInstalled(id)` is defined as "the `system/services/<id>` symlink exists."
Installation is atomic: if any step fails (bad manifest, id mismatch), every
symlink created so far in that call is rolled back
(`createSymlinks()`'s try/catch in `symlinkManager.ts`).

Uninstalling reverses this: stop the service if running, remove every
symlink, unregister it — and that's it. **Uninstall never deletes the item's
source.** `dataDir()/user-apps/<id>/` is the user's own GitFS repo (the exact
same concept as `user-specs/` — BOS never populates or deletes from it, only
ensures it's a git repo), so install/uninstall are purely a matter of
creating/removing symlinks into whatever is already there. A marketplace
clone under `dataDir()/marketplace/<mktId>/items/<id>/` is equally untouched
by uninstall, regardless of which path the item was originally installed
from.

### Where an item can come from

| Source | How it gets into `user-apps/` | Discovered from |
|---|---|---|
| **The user's own repo** | The user clones/manages `dataDir()/user-apps/` themselves — BOS only runs `ensureRepo()` on it at boot (`src/instrumentation.node.ts`), a no-op if it's already a git repo | `dataDir()/user-apps/<id>/` |
| **Marketplace (adopted)** | `installMarketplaceService(marketplaceId, itemId)` (`src/lib/marketplace/client.ts`) copies the clone's `item.services.entrypoint` folder into `user-apps/<id>/` and commits it (mirroring `adoptSpec()`'s fork-and-commit), then calls `installService()` | Marketplace clone at `dataDir()/marketplace/<mktId>/items/<itemId>/`, or the resulting `user-apps/<id>/` copy |
| **Hand-authored** | Place the folder directly under `dataDir()/user-apps/<id>/` | Same |

`ServiceRegistry.discoverServices()` scans both `user-apps/` and
`marketplace/<id>/items/` for a `services/service.json` — that's how an item
shows up in **source state** (installable) before it's ever installed.

> **`dataDir()/user-apps/` is itself an always-present "local marketplace"**
> under the reserved id `LOCAL_MARKETPLACE_ID` ("user-apps"), auto-scanned by
> `src/lib/marketplace/client.ts` (`scanUserAppsManifest()`/`readManifest()`) —
> computed **in memory only, on every catalog read**; BOS never writes a
> generated `marketplace.json` (or anything else) into this repo, since it may
> be the user's real, possibly remote-tracked git history.
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
  `user-apps/` or `marketplace/<id>/items/`, discovered but not installed.
- **Installed state** — the `system/services/<id>` symlink exists; the service
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

See §11 below for a complete real example (WebSocket server + per-connection
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
  through the item's `data/system/app/<id>` symlink; 404 if the item has no
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

## 11. Worked example: a Terminal service

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
marketplace (user-apps/), the app runs same-origin (origin `"local"`), so a
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
deployed behind a reverse proxy (§13). Any service with its own network port
should follow this same pattern.

BOS itself doesn't ship this item — `dataDir()/user-apps/` is the user's own
GitFS repo (§4), so there's nothing built in to seed. `tests/services/`'s
fixtures (`_worker-fixtures.ts` and `layOutItem()`/`layOutServiceAndApp()`
helpers in the integration/local-marketplace test files) construct a synthetic
item with this exact shape to exercise the real install/uninstall/registry
flow end to end — read those if you want a runnable reference to copy from.

---

## 12. Testing

Unit/integration tests for services live under `tests/services/` and run on
**Playwright's test runner** in Node mode (not a browser) —
`npx playwright test -c playwright.unit.config.ts tests/services/`. Conventions:
`useTestDataDir(label)` (fresh temp `BOS_DATA_DIR`), `resetServiceSingletons()`
(clears the `globalThis` registry/manager), real (unmocked) `fs`/`worker_threads`
with small fixture worker scripts (`_worker-fixtures.ts`). `integration.test.ts`
specifically exercises the real `createSymlinks`/`installService`/
`uninstallService` functions end-to-end, not the registry's
`registerInstalled()` shortcut the other unit tests use.

One easy-to-repeat mistake: `validateManifestAtStart(manifest, servicesRootPath)`
resolves `<servicesRootPath>/<manifest.id>/<entry>` — mirroring the real
`dataDir()/system/services/<id>` symlink farm — **not**
`<itemDir>/services/<entry>`. If you're calling it directly against an item on
disk (rather than through the installer), build a one-symlink farm
(`<tmp>/<id> -> <itemPath>/services`) and pass the farm's parent dir.

> **Green tests are not proof the feature works.** The unit suite runs plain
> Node against `serviceRegistry()`/`serviceManager()` directly — it never goes
> through `instrumentation.ts`'s boot hook, never runs under Turbopack, and
> never touches the iframe sandbox. All tests were passing while (a)
> `instrumentation.node.ts` had never actually run once in the real app (see
> [Design heuristics](../design-heuristics.md)) and (b) `new Worker(entryPath)`
> was silently failing under `next dev`. Both were only caught by starting
> `npm run dev` and driving the real HTTP API end to end (`POST
> /api/services/<id>` with `{action:"start"}`, then checking `state ===
> "running"` and actually connecting to the bound port). Do this after
> touching anything in this doc's §4/§6 — don't stop at green tests.

---

## 13. Known limitations

- No CPU isolation between services (memory-isolated via separate V8 heaps only;
  a CPU-bound worker can still starve BOS and other services).
- No container-based services (Docker) — worker threads only, for v1.
- **A service's own network port isn't reachable directly once BOS is deployed
  behind a reverse proxy** (Traefik/nginx/etc. — e.g. Dokploy) — only the
  Supervisor's public port is exposed/TLS-terminated there. Fixed for
  Supervisor-managed deployments (i.e. any Docker deployment — the Supervisor
  always owns the public port there): `GET /api/services/<id>/config` returns
  a `wsPath` field (`/__supervisor/services/<id>/ws`) whenever
  `supervisorEnabled()` is true; the client should connect to
  `${wsScheme}//${location.host}${wsPath}` instead of the service's own
  `host:port` when `wsPath` is present (fall back to direct `host:port` when
  it's absent — that's the plain `npm run dev`, no-Supervisor case, which
  already works). `tools/supervisor/supervisor.mjs`'s `proxyServiceUpgrade()`
  resolves the actual bound port from `dataDir()/config/<id>/runtime.json` and
  forwards the WS upgrade there — the same mechanism the Supervisor already
  used for Next dev's HMR socket, just with the target port sourced
  differently. See the Terminal example (§11) for the exact client pattern.
  Any new service with its own network port should follow this same
  `wsPath`-if-present-else-direct-port pattern.
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
