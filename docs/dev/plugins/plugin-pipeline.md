# Plugin pipeline (agent-loop hooks)

Server-side plugins that hook into the assistant's run loop — before/after the
LLM call, before/after each tool call, on completion, on error. Distinct from
[Service Daemons](../apps/services.md), which are long-running background
processes, and from the assistant's own interception seam documented in
[Assistant overview §Run hooks](../assistant/overview.md) (`src/lib/assistant/hooks.ts`,
which plugins compose into).

**Naming note:** the spec for Service Daemons (`user-specs/002-service-daemons`,
FR-034–FR-037) calls for this system to be renamed from "plugins" to "hooks"
(`registerPlugin()` → `registerHook()`, `plugin.json` → `hook.json`) so a
service's optional `hooks/` directory has something to register into. That
rename has **not** happened — the code below (`registerPlugin`, `plugin.json`,
`src/lib/plugins/*`) is the current, real state.

---

## 1. What a plugin can do

A plugin implements any subset of `BosPluginHooks` (`src/lib/plugins/types.ts`):

| Hook | Timing | Can do |
|---|---|---|
| `beforeRun(messages, ctx)` | Before the LLM call | Inspect/rewrite the message array |
| `extendSystemPrompt(ctx)` | Before the LLM call | Append text to the system prompt (multiple plugins concatenate) |
| `beforeToolCall(call, ctx)` | Before a tool executes | Veto or inspect a tool call — first `deny` wins |
| `afterToolCall(call, result, ctx)` | After a tool executes | Observe the settled result |
| `afterRun(response, ctx)` | After the LLM responds | Inspect/rewrite the response |
| `onRunFinished(summary, ctx)` | Run completion (any reason) | Observe |
| `onError(error, ctx)` | On error | Observe |

Every hook is wrapped in a 15s timeout and a try/catch
(`guarded()` in `src/lib/plugins/registry.ts`) — a slow or throwing plugin hook
never blocks or crashes a run; it just logs and is skipped for that call.

The two built-in plugins are `bos-compaction` (`src/plugins/compaction/`) and
`bos-memory` (`src/plugins/memory/`) — read their `index.ts` for a working
reference implementation of `PluginDefinition`.

---

## 2. Plugin manifest (`plugin.json` / `PluginManifest`)

```ts
interface PluginManifest {
  id: string;                    // e.g. "bos-compaction"
  name: string;
  version: string;
  type: "server-plugin";         // the only type today
  provides: PluginHookType[];    // which hooks this plugin implements
  configSchema?: Record<string, unknown>;   // JSON Schema, rendered in Settings
  entry?: string;                 // default "index.js"
  configApp?: string;
  settingsRegistration?: { label: string; icon?: string; description?: string };
  description?: string;
  author?: string;
  homepage?: string;
}
```

A `PluginDefinition` (the runtime object passed to `registerPlugin()`) pairs a
manifest with the actual hook implementations plus optional
`initialize(context)` / `dispose()` / `getConfig()` / `setConfig(config)`.

`PluginContext` gives a plugin `dataDir`, scoped `readFile`/`writeFile` (its own
directory only), `readTranscript(conversationId)`, and `log()`.

---

## 3. Registry & lifecycle

`src/lib/plugins/registry.ts` — a `globalThis`-backed singleton
(`__bosPluginRegistry`, same hot-reload-safety pattern as the service registry):

- `registerPlugin(def)` — register/replace by id.
- `unregisterPlugin(id)` — calls `dispose()` if present, then removes it.
- `listPlugins()` — registration order == pipeline execution order.
- `composePluginHooks(plugins, onError)` — folds every registered plugin's
  hooks into one `RunHooks`-shaped object; `beforeToolCall` short-circuits on
  the first plugin that returns a deny decision.

`src/lib/plugins/loader.ts` handles on-disk plugins (under `dataDir()/plugins/`)
and a one-time legacy-config migration (`data/config/compaction.json` /
`memoryLoops.json` → `data/config/plugins.json`, gated by a `.plugins-migrated`
marker so it only runs once). Built-in plugins instead register themselves at
import time via a tiny `init.ts` (`import "@/plugins/compaction/init"` calls
`registerPlugin(compactionPlugin)` as a side effect) — both
`src/app/api/plugins/route.ts` and `src/instrumentation.ts` import these
`init` modules so the registry is populated regardless of which loads first.

Where hooks actually run: `src/lib/assistant/start-run.ts` calls
`listPlugins()` + `composePluginHooks()` and merges the result into the run's
`RunHooks` alongside `src/lib/assistant/hooks.ts`'s own registrations.

`src/lib/plugins/monitor.ts` tracks in-flight hook invocations (for the
15s-timeout accounting above) and can detect hangs.

---

## 4. Config & persistence

- `dataDir()/config/plugins.json` — `{ active: string[], config: Record<id, Record<string, unknown>> }`.
  `active` is both the enabled-set AND the execution order.
- Per-plugin config is validated against `configSchema` and rendered generically
  in Settings (`PluginsTab.tsx`'s `SchemaConfigForm` — string/number/boolean/enum
  fields, no custom `configApp` component lookup exists yet).
- `src/lib/plugins/settings.ts` — `getPluginsForSettings()`, `savePluginSettings()`,
  `setPluginOrder()`, `ensureDefaultPlugins()` (seeds `bos-compaction`/`bos-memory`
  as active on first run).

---

## 5. Installing a third-party plugin

`installServerPlugin(marketplaceId, itemId)` (`src/lib/marketplace/client.ts`)
copies a marketplace item's `serverPlugin.entrypoint` (or falls back to
`app.entrypoint`) into the local plugin store and registers it — same
division of labor as `installApp`/`installMarketplaceService`. Unlike those two,
`POST /api/marketplace` has no `install-server-plugin` op wired to it yet, and
the Marketplace app's frontend has no `serverPlugin` badge/button either (same
gap as services — see [Service Daemons §4](../apps/services.md#4-install-symlink-mapping)).
The function is currently only reachable from server-side code or a test.

---

## 6. API routes

| Route | Methods | Purpose |
|---|---|---|
| `/api/plugins` | GET | List plugins + their Settings-facing status (`PluginStatus[]`) |
| `/api/plugins` | PATCH | `{ pluginId, active?, config?, order? }` — toggle, reconfigure, or reorder one plugin |
| `/api/plugins` | PUT | `{ orderedIds: string[] }` — set full pipeline order (drag-to-reorder in Settings) |
| `/api/plugins` | DELETE | `{ pluginId }` — uninstall (calls `dispose()`) |

---

## 7. Settings UI

`src/components/apps/settings/PluginsTab.tsx` — drag-to-reorder plugin list
(left sidebar), Active/Inactive toggle per plugin, and a detail pane on the
right showing the plugin's `configSchema`-driven form. The same sidebar also
hosts the [Services](../apps/services.md) list below the plugin list — they
share one Settings tab (registered as `"plugins"` /
`src/lib/config/registry.ts`, title "Plugins") but are otherwise independent
systems that happen to live in the same panel.

---

## 8. Known limitations

- No `hooks/`-directory service integration yet — see
  [Service Daemons §8](../apps/services.md#8-the-optional-hooks-directory-currently-inert).
- No custom `configApp` component resolution — every plugin gets the generic
  schema-driven form.
- No Marketplace UI for installing a `serverPlugin`-typed item (§5).
