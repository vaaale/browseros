# BOS Plugin Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `claude-superskills:executing-plans` to implement this plan task-by-task.

**Goal:** Implement 032 Phase A (generic plugin infrastructure) and 033 Phases 1–3 (pluggable voice engines), enabling marketplace items to register API routes, settings panels, and TTS engines at runtime.

**Architecture:** A new `src/lib/bos-plugins/` subsystem (distinct from the existing `src/lib/plugins/` LLM pipeline system) provides a route registry, settings panel registry, and plugin loader. A single Next.js catch-all route `src/app/api/plugin/[pluginId]/[...path]/route.ts` dispatches to registered handlers. The voice engine is extracted from a hardcoded switch into a `globalThis`-backed registry that plugins register into.

**Tech Stack:** Next.js App Router, TypeScript, Node.js `globalThis` singletons for HMR safety, Next.js `instrumentation.ts` for startup loading.

**Branch:** `git checkout -b bos/plugin-infrastructure`

---

## Task 1: Plugin types

**Files:**
- Create: `src/lib/bos-plugins/types.ts`

**Step 1: Create the file**

```typescript
// src/lib/bos-plugins/types.ts
// Framework-free — no server-only, no React. Safe to import from client.

export interface PluginRouteContext {
  pluginId: string;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type RouteHandler = (
  req: Request,
  ctx: PluginRouteContext,
) => Promise<Response>;

export interface RouteRegistration {
  method: RouteMethod;
  /** Normalised path, e.g. "/session" or "/app/bundle.js". Leading slash required. */
  path: string;
  handler: RouteHandler;
}

export interface SettingsPanelRegistration {
  pluginId: string;
  label: string;
  /** lucide-react icon name */
  icon: string;
  order: number;
  configSchema: Record<string, unknown>;
  /** Keys whose values are stored in the secrets store and never returned to the browser. */
  secretFields: string[];
}

export interface BosPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  bosVersion?: string;
  sdkVersion?: string;
  entry?: string;
}

export interface BosPluginContext {
  pluginId: string;
  log: PluginRouteContext["log"];
}

export interface BosPluginModule {
  activate?(ctx: BosPluginContext): Promise<void>;
  deactivate?(ctx: BosPluginContext): Promise<void>;
}

export interface VoiceEnginePlugin {
  id: string;
  displayName: string;
  configSchema?: Record<string, unknown>;
  onSessionStart?(sessionId: string): Promise<void>;
  onSessionEnd?(sessionId: string): Promise<void>;
  speak(
    text: string,
    config: Record<string, unknown>,
    sessionId: string,
  ): Promise<{ durationMs: number; audioUrl?: string }>;
  interrupt(sessionId: string): Promise<void>;
}
```

**Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors from the new file.

**Step 3: Commit**
```bash
git add src/lib/bos-plugins/types.ts
git commit -m "feat(plugins): add BOS plugin type definitions"
```

---

## Task 2: Route registry

**Files:**
- Create: `src/lib/bos-plugins/route-registry.ts`

**Step 1: Create the file**

```typescript
// src/lib/bos-plugins/route-registry.ts
import type { RouteMethod, RouteHandler, RouteRegistration } from "./types";

const KEY = "__bos_plugin_routes__" as const;

function getRegistry(): Map<string, RouteRegistration[]> {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new Map<string, RouteRegistration[]>();
  return g[KEY] as Map<string, RouteRegistration[]>;
}

export function registerRoute(
  pluginId: string,
  method: RouteMethod,
  path: string,
  handler: RouteHandler,
): void {
  const reg = getRegistry();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const entries = reg.get(pluginId) ?? [];
  entries.push({ method, path: normalized, handler });
  reg.set(pluginId, entries);
}

export function unregisterRoutes(pluginId: string): void {
  getRegistry().delete(pluginId);
}

export function matchRoute(
  pluginId: string,
  method: string,
  path: string,
): RouteHandler | undefined {
  const entries = getRegistry().get(pluginId);
  if (!entries) return undefined;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const entry = entries.find(
    (e) => e.method === method.toUpperCase() && e.path === normalized,
  );
  return entry?.handler;
}

export function isPluginRegistered(pluginId: string): boolean {
  return getRegistry().has(pluginId);
}
```

**Step 2: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**
```bash
git add src/lib/bos-plugins/route-registry.ts
git commit -m "feat(plugins): add plugin route registry"
```

---

## Task 3: Settings panel registry

**Files:**
- Create: `src/lib/bos-plugins/settings-registry.ts`

**Step 1: Create the file**

```typescript
// src/lib/bos-plugins/settings-registry.ts
import type { SettingsPanelRegistration } from "./types";

const KEY = "__bos_plugin_settings__" as const;

function getRegistry(): Map<string, SettingsPanelRegistration> {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new Map<string, SettingsPanelRegistration>();
  return g[KEY] as Map<string, SettingsPanelRegistration>;
}

export function registerSettingsPanel(entry: SettingsPanelRegistration): void {
  getRegistry().set(entry.pluginId, entry);
}

export function unregisterSettingsPanel(pluginId: string): void {
  getRegistry().delete(pluginId);
}

export function listSettingsPanels(): SettingsPanelRegistration[] {
  return [...getRegistry().values()];
}
```

**Step 2: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**
```bash
git add src/lib/bos-plugins/settings-registry.ts
git commit -m "feat(plugins): add plugin settings panel registry"
```

---

## Task 4: Generic catch-all route

**Files:**
- Create: `src/app/api/plugin/[pluginId]/[...path]/route.ts`

**Step 1: Create the file**

```typescript
// src/app/api/plugin/[pluginId]/[...path]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { matchRoute, isPluginRegistered } from "@/lib/bos-plugins/route-registry";
import type { PluginRouteContext } from "@/lib/bos-plugins/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildHandler(method: string) {
  return async function handler(
    req: NextRequest,
    { params }: { params: Promise<{ pluginId: string; path: string[] }> },
  ) {
    const { pluginId, path: pathSegments } = await params;
    const path = "/" + pathSegments.join("/");

    if (!isPluginRegistered(pluginId)) {
      return NextResponse.json(
        { error: `Plugin '${pluginId}' is not installed or active.` },
        { status: 404 },
      );
    }

    const routeHandler = matchRoute(pluginId, method, path);
    if (!routeHandler) {
      return NextResponse.json(
        { error: `No handler for ${method} ${path} in plugin '${pluginId}'.` },
        { status: 404 },
      );
    }

    const ctx: PluginRouteContext = {
      pluginId,
      log: {
        info: (msg) => console.log(`[plugin:${pluginId}] ${msg}`),
        warn: (msg) => console.warn(`[plugin:${pluginId}] ${msg}`),
        error: (msg) => console.error(`[plugin:${pluginId}] ${msg}`),
      },
    };

    try {
      return await routeHandler(req, ctx);
    } catch (err) {
      console.error(`[plugin:${pluginId}] Route error on ${method} ${path}:`, err);
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 500 },
      );
    }
  };
}

export const GET = buildHandler("GET");
export const POST = buildHandler("POST");
export const PUT = buildHandler("PUT");
export const DELETE = buildHandler("DELETE");
export const PATCH = buildHandler("PATCH");
```

**Step 2: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Smoke test** — start dev server and confirm:
```bash
curl -s http://localhost:3000/api/plugin/nonexistent/anything | jq .
```
Expected: `{"error":"Plugin 'nonexistent' is not installed or active."}`

**Step 4: Commit**
```bash
git add src/app/api/plugin/
git commit -m "feat(plugins): add generic catch-all plugin route dispatcher"
```

---

## Task 5: Plugin SDK entry point + package alias

**Files:**
- Create: `src/lib/bos-plugins/sdk/index.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Step 1: Create SDK barrel**

```typescript
// src/lib/bos-plugins/sdk/index.ts
// BOS Plugin SDK — imported by plugins as "#bos-plugin-sdk".
// Re-exports the registration functions plugins need.

export { registerRoute, unregisterRoutes } from "@/lib/bos-plugins/route-registry";
export { registerSettingsPanel, unregisterSettingsPanel } from "@/lib/bos-plugins/settings-registry";
export { registerVoiceEngine, unregisterVoiceEngine } from "@/lib/voice/engine-registry";
export { registerIntegration, unregisterIntegration } from "@/lib/integrations/registry";
export { registerAdapter, unregisterAdapter } from "@/lib/integrations/actions/adapter-registry";
export { registerWebhookHandler, unregisterWebhookHandler } from "@/lib/integrations/webhooks/registry";

export type {
  BosPluginContext,
  BosPluginModule,
  PluginRouteContext,
  RouteMethod,
  RouteHandler,
  SettingsPanelRegistration,
  VoiceEnginePlugin,
} from "@/lib/bos-plugins/types";
```

> Note: `registerVoiceEngine` does not exist yet — it is added in Task 14. The SDK file will have a type error until then. Leave it; the SDK is not imported by anything until the loader in Task 11.

**Step 2: Add `imports` alias to `package.json`**

Open `package.json`. After the `"private": true` line, add:
```json
  "imports": {
    "#bos-plugin-sdk": "./src/lib/bos-plugins/sdk/index.ts"
  },
```

**Step 3: Add path alias to `tsconfig.json`**

In `tsconfig.json`, inside `compilerOptions.paths`, add:
```json
"#bos-plugin-sdk": ["./src/lib/bos-plugins/sdk/index.ts"]
```

**Step 4: Commit** (after Task 14 resolves the engine-registry import)
> Hold this commit until Task 14 is complete.

---

## Task 6: Update config registry to include plugin panels

**Files:**
- Modify: `src/lib/config/registry.ts`

**Step 1: Add import at top of file** (after existing imports):
```typescript
import { listSettingsPanels } from "@/lib/bos-plugins/settings-registry";
import type { SettingsPanelRegistration } from "@/lib/bos-plugins/types";
```

**Step 2: Update `listConfigSchemas()`** — replace the existing function:
```typescript
export function listConfigSchemas(): ConfigSchema[] {
  const pluginSchemas: ConfigSchema[] = listSettingsPanels().map((p) => ({
    namespace: `plugin:${p.pluginId}`,
    title: p.label,
    icon: p.icon,
    order: p.order,
    fields: Object.entries(
      (p.configSchema as { properties?: Record<string, { type?: string; description?: string }> }).properties ?? {},
    ).map(([key, def]) => ({
      key,
      label: key,
      type: (def.type as "text" | "number" | "boolean") ?? "text",
      description: def.description,
      secret: p.secretFields.includes(key),
    })),
  }));

  return [...REGISTRATIONS, ...pluginSchemas.map((schema) => ({
    schema,
    load: async () => ({}),
    save: async () => {},
  }))]
    .sort((a, b) => (a.schema.order ?? 100) - (b.schema.order ?? 100))
    .map((r) => r.schema);
}
```

**Step 3: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
git add src/lib/config/registry.ts src/lib/bos-plugins/settings-registry.ts
git commit -m "feat(plugins): plugin settings panels included in config schema list"
```

---

## Task 7: Integration registry — add `unregisterIntegration`

**Files:**
- Modify: `src/lib/integrations/registry.ts`

**Step 1: Read the file**, confirm the shape of the `globalThis` registry, then add after `registerIntegration`:

```typescript
export function unregisterIntegration(id: string): void {
  const registry = getRegistry();
  const idx = registry.findIndex((m) => m.id === id);
  if (idx !== -1) registry.splice(idx, 1);
}
```

**Step 2: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**
```bash
git add src/lib/integrations/registry.ts
git commit -m "feat(plugins): add unregisterIntegration to integration registry"
```

---

## Task 8: Adapter registry — HMR guard + `unregisterAdapter` + `methodDescriptors`

**Files:**
- Modify: `src/lib/integrations/actions/adapter-registry.ts`

**Step 1: Read the current file** to understand the shape, then make these changes:

a) Add `methodDescriptors` to the `AdapterEntry` interface:
```typescript
export interface AdapterEntry {
  createAdapter: () => ServiceAdapter;
  methods: readonly AdapterMethodMeta<any>[];
  capabilities?: AdapterCapabilities;
  /** Framework-free descriptors for the capabilities registry. */
  methodDescriptors?: readonly AdapterMethodDescriptor[];
}

export interface AdapterMethodDescriptor {
  method: string;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}
```

b) Back the registry with `globalThis` (replace the bare `const ADAPTERS = ...`):
```typescript
const ADAPTERS_KEY = "__bos_adapter_registry__" as const;
function getAdapters(): Record<string, Record<string, AdapterEntry>> {
  const g = globalThis as Record<string, unknown>;
  if (!g[ADAPTERS_KEY]) g[ADAPTERS_KEY] = {};
  return g[ADAPTERS_KEY] as Record<string, Record<string, AdapterEntry>>;
}
```
Update all references from `ADAPTERS` to `getAdapters()`.

c) Change `registerAdapter` duplicate guard from throw to replace:
```typescript
export function registerAdapter(
  integrationId: string,
  serviceId: string,
  entry: AdapterEntry,
): void {
  const adapters = getAdapters();
  if (!adapters[integrationId]) adapters[integrationId] = {};
  adapters[integrationId][serviceId] = entry; // replace, not throw
}
```

d) Add `unregisterAdapter`:
```typescript
export function unregisterAdapter(integrationId: string, serviceId: string): void {
  const adapters = getAdapters();
  if (adapters[integrationId]) {
    delete adapters[integrationId][serviceId];
    if (Object.keys(adapters[integrationId]).length === 0) {
      delete adapters[integrationId];
    }
  }
}
```

**Step 2: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**
```bash
git add src/lib/integrations/actions/adapter-registry.ts
git commit -m "feat(plugins): adapter registry — HMR guard, unregister, methodDescriptors field"
```

---

## Task 9: Webhook registry — add registration functions

**Files:**
- Modify: `src/lib/integrations/webhooks/registry.ts`

**Step 1: Add a dynamic registry alongside the static `HANDLERS`:**

```typescript
const DYNAMIC_KEY = "__bos_webhook_handlers__" as const;
function getDynamic(): Record<string, Record<string, WebhookHandler>> {
  const g = globalThis as Record<string, unknown>;
  if (!g[DYNAMIC_KEY]) g[DYNAMIC_KEY] = {};
  return g[DYNAMIC_KEY] as Record<string, Record<string, WebhookHandler>>;
}

export function registerWebhookHandler(
  integrationId: string,
  serviceId: string,
  handler: WebhookHandler,
): void {
  const d = getDynamic();
  if (!d[integrationId]) d[integrationId] = {};
  d[integrationId][serviceId] = handler;
}

export function unregisterWebhookHandler(integrationId: string, serviceId: string): void {
  const d = getDynamic();
  if (d[integrationId]) {
    delete d[integrationId][serviceId];
  }
}
```

**Step 2: Update `getWebhookHandler` to check dynamic registry first:**
```typescript
export function getWebhookHandler(integrationId: string, serviceId: string): WebhookHandler | undefined {
  return getDynamic()[integrationId]?.[serviceId] ?? HANDLERS[integrationId]?.[serviceId];
}
```

**Step 3: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
git add src/lib/integrations/webhooks/registry.ts
git commit -m "feat(plugins): add registerWebhookHandler / unregisterWebhookHandler"
```

---

## Task 10: Capabilities registry — make dynamic

**Files:**
- Modify: `src/lib/agent/capabilities-registry.ts`

**Step 1: Remove the 5 hardcoded descriptor imports** (lines that import `GMAIL_METHOD_DESCRIPTORS`, `DRIVE_METHOD_DESCRIPTORS`, etc.) and the 5 `const *_CAPABILITIES = integrationCapabilities(...)` lines.

**Step 2: Add a dynamic builder after the `integrationCapabilities` helper function:**

```typescript
import { listAdapterServices } from "@/lib/integrations/actions/adapter-registry";

function listIntegrationCapabilities(): Capability[] {
  return listAdapterServices().flatMap(({ integrationId, serviceId, methods }) => {
    // Group label: derive from service id capitalised
    const group = serviceId.charAt(0).toUpperCase() + serviceId.slice(1);
    return methods.map((m) => ({
      id: actionNameFor(integrationId, serviceId, m.method),
      group,
      context: "action" as const,
      description: m.description,
    }));
  });
}
```

**Step 3: Replace the static `CAPABILITIES` array export** — change from:
```typescript
export const CAPABILITIES: Capability[] = [
  // OS …
  ...GMAIL_CAPABILITIES,
  ...DRIVE_CAPABILITIES,
  // etc.
];
```
To:
```typescript
const STATIC_CAPABILITIES: Capability[] = [
  // OS
  { id: "bos_app_launch", … },
  // … all static entries, exactly as they are now …
  // (remove only the integration spread lines)
];

export function listCapabilities(): Capability[] {
  return [...STATIC_CAPABILITIES, ...listIntegrationCapabilities()];
}

// Back-compat alias for call sites that read CAPABILITIES directly.
// TODO: migrate all callers to listCapabilities().
export const CAPABILITIES: Capability[] = new Proxy([] as Capability[], {
  get(_, prop) {
    if (prop === "length") return listCapabilities().length;
    if (typeof prop === "string" && !isNaN(Number(prop)))
      return listCapabilities()[Number(prop)];
    if (prop === Symbol.iterator) {
      return () => listCapabilities()[Symbol.iterator]();
    }
    return (listCapabilities() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
```

> Note: The `Proxy` is a pragmatic back-compat shim so existing consumers of `CAPABILITIES` keep working. New code should call `listCapabilities()`.

**Step 4: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**
```bash
git add src/lib/agent/capabilities-registry.ts
git commit -m "feat(plugins): capabilities registry reads from adapter registry dynamically"
```

---

## Task 11: Plugin loader

**Files:**
- Create: `src/lib/bos-plugins/loader.ts`

**Step 1: Create the file**

```typescript
// src/lib/bos-plugins/loader.ts
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import type { BosPluginManifest, BosPluginModule, BosPluginContext } from "./types";

const PLUGINS_DIR = () => path.join(dataDir(), "bos-plugins");
const LOADED_KEY = "__bos_loaded_plugins__" as const;

function getLoaded(): Map<string, BosPluginManifest> {
  const g = globalThis as Record<string, unknown>;
  if (!g[LOADED_KEY]) g[LOADED_KEY] = new Map<string, BosPluginManifest>();
  return g[LOADED_KEY] as Map<string, BosPluginManifest>;
}

function makeContext(pluginId: string): BosPluginContext {
  return {
    pluginId,
    log: {
      info: (msg) => console.log(`[bos-plugin:${pluginId}] ${msg}`),
      warn: (msg) => console.warn(`[bos-plugin:${pluginId}] ${msg}`),
      error: (msg) => console.error(`[bos-plugin:${pluginId}] ${msg}`),
    },
  };
}

export async function loadPlugin(pluginDir: string): Promise<void> {
  const manifestPath = path.join(pluginDir, "bos-plugin.json");
  let manifest: BosPluginManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as BosPluginManifest;
  } catch {
    console.warn(`[bos-plugins] Skipping ${pluginDir}: missing or invalid bos-plugin.json`);
    return;
  }
  if (!manifest.id) {
    console.warn(`[bos-plugins] Skipping ${pluginDir}: manifest missing id`);
    return;
  }
  if (getLoaded().has(manifest.id)) return; // already loaded (e.g. HMR re-run)

  const entryFile = path.join(pluginDir, manifest.entry ?? "index.js");
  let mod: BosPluginModule;
  try {
    mod = (await import(/* webpackIgnore: true */ entryFile)) as BosPluginModule;
    if (mod.default) mod = mod.default as BosPluginModule;
  } catch (err) {
    console.error(`[bos-plugins] Failed to load plugin ${manifest.id}:`, err);
    return;
  }

  const ctx = makeContext(manifest.id);
  try {
    await mod.activate?.(ctx);
  } catch (err) {
    console.error(`[bos-plugins] activate() failed for ${manifest.id}:`, err);
    return;
  }

  getLoaded().set(manifest.id, manifest);
  ctx.log.info(`loaded v${manifest.version}`);
}

export async function loadAllPlugins(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(PLUGINS_DIR());
  } catch {
    return; // directory doesn't exist yet — no plugins installed
  }
  await Promise.all(
    entries.map((name) => loadPlugin(path.join(PLUGINS_DIR(), name))),
  );
}

export function listLoadedPlugins(): BosPluginManifest[] {
  return [...getLoaded().values()];
}
```

**Step 2: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**
```bash
git add src/lib/bos-plugins/loader.ts
git commit -m "feat(plugins): BOS plugin loader with per-plugin error isolation"
```

---

## Task 12: `instrumentation.ts` — Next.js startup hook

**Files:**
- Create: `instrumentation.ts` (at repo root, next to `package.json`)

**Step 1: Create the file**

```typescript
// instrumentation.ts
// Next.js startup hook — runs once per server process before any request.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { loadAllPlugins } = await import("./src/lib/bos-plugins/loader");
    await loadAllPlugins();
  }
}
```

**Step 2: Verify Next.js picks it up** — confirm `next.config.js` (or `next.config.ts`) has `experimental.instrumentationHook` enabled, or check if it's enabled by default in this Next.js version.

Read `next.config.ts` or `next.config.js`:
```bash
cat next.config.* 2>/dev/null | head -30
```

If the file has an `experimental` block, add `instrumentationHook: true`. If there is no such block, add it:
```javascript
experimental: {
  instrumentationHook: true,
}
```

**Step 3: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Validate Phase A** — create a minimal test plugin to confirm the loader works:

```bash
mkdir -p data/bos-plugins/hello-test
```

Create `data/bos-plugins/hello-test/bos-plugin.json`:
```json
{
  "id": "hello-test",
  "name": "Hello Test Plugin",
  "version": "0.1.0",
  "entry": "index.js"
}
```

Create `data/bos-plugins/hello-test/index.js`:
```js
"use strict";
// Minimal test plugin — registers one GET route.
const { registerRoute } = require("../../src/lib/bos-plugins/route-registry");

module.exports = {
  async activate(ctx) {
    registerRoute(ctx.pluginId, "GET", "/hello", async () => {
      return Response.json({ message: "Hello from hello-test plugin!" });
    });
    ctx.log.info("activated");
  },
  async deactivate(ctx) {
    const { unregisterRoutes } = require("../../src/lib/bos-plugins/route-registry");
    unregisterRoutes(ctx.pluginId);
  },
};
```

Restart dev server, then:
```bash
curl -s http://localhost:3000/api/plugin/hello-test/hello | jq .
```
Expected: `{"message":"Hello from hello-test plugin!"}`

**Step 5: Clean up test plugin after validation**
```bash
rm -rf data/bos-plugins/hello-test
```

**Step 6: Commit**
```bash
git add instrumentation.ts next.config.*
git commit -m "feat(plugins): add instrumentation.ts startup hook for plugin loading"
```

**Step 7: Commit SDK + package.json (from Task 5)**
```bash
git add src/lib/bos-plugins/sdk/index.ts package.json tsconfig.json
git commit -m "feat(plugins): add @bos/plugin-sdk entry point and package imports alias"
```

---

## Task 13: Voice engine registry

**Files:**
- Create: `src/lib/voice/engine-registry.ts`

**Step 1: Create the file**

```typescript
// src/lib/voice/engine-registry.ts
import type { VoiceEnginePlugin } from "@/lib/bos-plugins/types";

const KEY = "__bos_voice_engines__" as const;

function getRegistry(): Map<string, VoiceEnginePlugin> {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new Map<string, VoiceEnginePlugin>();
  return g[KEY] as Map<string, VoiceEnginePlugin>;
}

export function registerVoiceEngine(engine: VoiceEnginePlugin): void {
  getRegistry().set(engine.id, engine);
}

export function unregisterVoiceEngine(id: string): void {
  getRegistry().delete(id);
}

export function getVoiceEngine(id: string): VoiceEnginePlugin | undefined {
  return getRegistry().get(id);
}

export function listVoiceEngines(): VoiceEnginePlugin[] {
  return [...getRegistry().values()];
}
```

**Step 2: Type-check** (this also resolves the import error in the SDK from Task 5):
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**
```bash
git add src/lib/voice/engine-registry.ts
git commit -m "feat(voice): add pluggable voice engine registry"
```

---

## Task 14: Split TTS engines + make index.ts a dispatcher

**Files:**
- Create: `src/lib/voice/tts/openai.ts`
- Create: `src/lib/voice/tts/omnivoice.ts`
- Modify: `src/lib/voice/tts/index.ts`
- Modify: `src/lib/voice/types.ts`

**Step 1: Create `src/lib/voice/tts/openai.ts`**

Move the `streamOpenAI` function body and `composeInstruct` helper from `index.ts` into this file. The engine registers itself on import:

```typescript
import "server-only";
import { registerVoiceEngine } from "@/lib/voice/engine-registry";
import type { VoiceConfig } from "../types";

async function streamOpenAI(text: string, cfg: VoiceConfig): Promise<Response> {
  // --- paste the existing streamOpenAI body here, unchanged ---
}

registerVoiceEngine({
  id: "openai-compatible",
  displayName: "OpenAI-compatible TTS",
  async speak(text, config, _sessionId) {
    const cfg = config as unknown as VoiceConfig;
    const res = await streamOpenAI(text, cfg);
    // Measure duration from content-length / bitrate estimate
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    const bitrate = cfg.openai.responseFormat === "mp3" ? 128000 : 256000;
    const durationMs = contentLength > 0 ? Math.round((contentLength * 8 / bitrate) * 1000) : 3000;
    const buffer = await res.arrayBuffer();
    const b64 = Buffer.from(buffer).toString("base64");
    const mimeType = res.headers.get("content-type") ?? "audio/mpeg";
    return {
      durationMs,
      audioUrl: `data:${mimeType};base64,${b64}`,
    };
  },
  async interrupt(_sessionId) {
    // HTTP TTS — nothing to cancel server-side
  },
});
```

**Step 2: Create `src/lib/voice/tts/omnivoice.ts`**

Same pattern — move `streamOmnivoice` and `composeInstruct` in, register as engine `"omnivoice"`.

**Step 3: Update `src/lib/voice/tts/index.ts`** — replace with dispatcher:

```typescript
import "server-only";
import "./openai";    // side-effect: registers "openai-compatible"
import "./omnivoice"; // side-effect: registers "omnivoice"
import { getVoiceEngine } from "@/lib/voice/engine-registry";
import type { VoiceConfig } from "../types";

export async function streamSpeech(
  text: string,
  cfg: VoiceConfig,
  _overrides: { voice?: string; language?: string } = {},
): Promise<{ durationMs: number; audioUrl?: string }> {
  const engine = getVoiceEngine(cfg.ttsProvider);
  if (!engine) throw new Error(`Unknown TTS engine: ${cfg.ttsProvider}`);
  return engine.speak(text, cfg as unknown as Record<string, unknown>, "");
}
```

**Step 4: Widen `ttsProvider` in `src/lib/voice/types.ts`**

Change:
```typescript
ttsProvider: TTSProviderType;
```
To:
```typescript
ttsProvider: string;  // "openai-compatible" | "omnivoice" | plugin-registered id
```

The `TTSProviderType` union can remain exported for back-compat but is no longer used on `VoiceConfig`.

**Step 5: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 6: Smoke test** — start dev server, send a TTS request:
```bash
curl -s -X POST http://localhost:3000/api/voice/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world"}' | jq '{ok: .ok, hasDuration: (.durationMs != null)}'
```
Expected: `{"ok": true, "hasDuration": true}` (after Task 15 changes the route).

**Step 7: Commit**
```bash
git add src/lib/voice/tts/ src/lib/voice/types.ts
git commit -m "feat(voice): split TTS engines into self-registering modules, dispatcher via registry"
```

---

## Task 15: Update `/api/voice/tts` to return JSON

**Files:**
- Modify: `src/app/api/voice/tts/route.ts`

**Step 1: Replace the route handler**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";
import { streamSpeech } from "@/lib/voice/tts";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { text?: string; voice?: string; language?: string };
    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }
    const cfg = await loadVoiceConfig();
    const result = await streamSpeech(body.text, cfg, {
      voice: body.voice,
      language: body.language,
    });
    return NextResponse.json({ ok: true, durationMs: result.durationMs, audioUrl: result.audioUrl });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

**Step 2: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**
```bash
git add src/app/api/voice/tts/route.ts
git commit -m "feat(voice): /api/voice/tts returns JSON {durationMs, audioUrl} instead of streaming body"
```

---

## Task 16: Voice session and interrupt routes

**Files:**
- Create: `src/app/api/voice/session/route.ts`
- Create: `src/app/api/voice/interrupt/route.ts`

**Step 1: Create session route**

```typescript
// src/app/api/voice/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { loadVoiceConfig } from "@/lib/voice/config";
import { getVoiceEngine } from "@/lib/voice/engine-registry";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { action, sessionId } = await req.json() as { action: "start" | "end"; sessionId?: string };
  const cfg = await loadVoiceConfig();
  const engine = getVoiceEngine(cfg.ttsProvider);

  if (action === "start") {
    const id = randomUUID();
    await engine?.onSessionStart?.(id);
    return NextResponse.json({ sessionId: id });
  }

  if (action === "end" && sessionId) {
    await engine?.onSessionEnd?.(sessionId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "invalid action" }, { status: 400 });
}
```

**Step 2: Create interrupt route**

```typescript
// src/app/api/voice/interrupt/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";
import { getVoiceEngine } from "@/lib/voice/engine-registry";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId?: string };
  const cfg = await loadVoiceConfig();
  const engine = getVoiceEngine(cfg.ttsProvider);
  await engine?.interrupt(sessionId ?? "");
  return NextResponse.json({ ok: true });
}
```

**Step 3: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
git add src/app/api/voice/session/route.ts src/app/api/voice/interrupt/route.ts
git commit -m "feat(voice): add session start/end and interrupt API routes"
```

---

## Task 17: Engine discovery on `GET /api/voice`

**Files:**
- Modify: `src/app/api/voice/route.ts`

**Step 1: Update the GET handler** to include engines:

```typescript
import { listVoiceEngines } from "@/lib/voice/engine-registry";
import "@/lib/voice/tts"; // side-effect: ensure built-in engines are registered

export async function GET() {
  const cfg = await loadVoiceConfig();
  const engines = listVoiceEngines().map((e) => ({
    id: e.id,
    displayName: e.displayName,
    configSchema: e.configSchema ?? null,
  }));
  return NextResponse.json({ config: redactVoiceConfig(cfg), engines });
}
```

**Step 2: Type-check**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Smoke test**
```bash
curl -s http://localhost:3000/api/voice | jq '.engines'
```
Expected: array containing `{ "id": "openai-compatible", ... }` and `{ "id": "omnivoice", ... }`.

**Step 4: Commit**
```bash
git add src/app/api/voice/route.ts
git commit -m "feat(voice): GET /api/voice returns available engines list"
```

---

## Task 18: Voice settings — dynamic engine selector

**Files:**
- Modify: `src/components/apps/settings/VoiceTab.tsx`

**Step 1: Read the current VoiceTab** to find the engine selector dropdown. It will reference `TTSProviderType` or have hardcoded options for `"openai-compatible"` and `"omnivoice"`.

**Step 2: Add engines to the state** fetched from `/api/voice`:

```typescript
interface Engine { id: string; displayName: string; configSchema: Record<string, unknown> | null; }
const [engines, setEngines] = useState<Engine[]>([]);

// In the existing fetch/load effect, extract engines from the response:
const data = await fetch("/api/voice").then(r => r.json()) as { config: VoiceConfig; engines: Engine[] };
setEngines(data.engines);
```

**Step 3: Replace the hardcoded engine dropdown options** with `engines.map(e => ({ value: e.id, label: e.displayName }))`.

**Step 4: Type-check and lint**
```bash
npx tsc --noEmit 2>&1 | head -20
npm run lint 2>&1 | tail -20
```

**Step 5: Commit**
```bash
git add src/components/apps/settings/VoiceTab.tsx
git commit -m "feat(voice): voice settings engine selector populated dynamically from registry"
```

---

## Task 19: Update `useVoice.ts` — session lifecycle + engine-agnostic speak

**Files:**
- Modify: `src/hooks/useVoice.ts`

This is the largest change. Read the file first to locate exact line numbers for each insertion point.

**Step 1: Add session ID ref** (near the top of the hook, alongside other refs):
```typescript
const sessionIdRef = useRef<string>("");
```

**Step 2: Add session start on voice activation** — find where voice mode is enabled/activated and add:
```typescript
// Start voice session with the current engine
const { sessionId } = await fetch("/api/voice/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "start" }),
}).then(r => r.json()) as { sessionId: string };
sessionIdRef.current = sessionId;
```

**Step 3: Add session end on voice deactivation** — find deactivation and add:
```typescript
if (sessionIdRef.current) {
  await fetch("/api/voice/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "end", sessionId: sessionIdRef.current }),
  }).catch(() => {});
  sessionIdRef.current = "";
}
```

**Step 4: Update the `speak` function** — find where it calls `fetch("/api/voice/tts", ...)` and plays an `Audio` element. Replace with engine-agnostic version:

```typescript
const speak = useCallback(async (text: string) => {
  setStatus("speaking");
  const result = await fetch("/api/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, sessionId: sessionIdRef.current }),
  }).then(r => r.json()) as { ok: boolean; durationMs: number; audioUrl?: string };

  if (result.audioUrl) {
    // Built-in engine: play locally
    const audio = new Audio(result.audioUrl);
    audio.onended = () => setStatus("dormant");
    await audio.play();
  } else {
    // Plugin engine (e.g. live-avatar): audio delivered externally
    // Use durationMs to schedule the status transition
    setTimeout(() => setStatus("dormant"), result.durationMs);
  }
}, []);
```

**Step 5: Update barge-in / interrupt** — find where `stopSpeaking()` cancels TTS. Add a call to the interrupt route:
```typescript
await fetch("/api/voice/interrupt", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: sessionIdRef.current }),
}).catch(() => {});
```

**Step 6: Type-check and lint**
```bash
npx tsc --noEmit 2>&1 | head -20
npm run lint 2>&1 | tail -20
```

**Step 7: End-to-end voice smoke test**
1. Open BOS in the browser.
2. Open Settings → Voice, confirm both built-in engines appear in the dropdown.
3. Enable voice mode and speak a phrase.
4. Confirm TTS audio plays (via `audioUrl` from the built-in engine).
5. Confirm barge-in interrupts TTS.

**Step 8: Commit**
```bash
git add src/hooks/useVoice.ts
git commit -m "feat(voice): useVoice — session lifecycle, engine-agnostic speak, interrupt route"
```

---

## Task 20: Final lint and type-check pass

```bash
npx tsc --noEmit
npm run lint
```

Fix any remaining issues, then:

```bash
git add -A
git commit -m "fix: resolve lint and type errors from plugin infrastructure work"
```

---

## Validation Checklist

- [ ] `GET /api/plugin/nonexistent/foo` → 404 "Plugin not installed"
- [ ] Test plugin registers route, route responds correctly
- [ ] `GET /api/voice` includes `engines` array with both built-in engines
- [ ] Voice mode still works end-to-end with both built-in engines
- [ ] Settings → Voice engine selector shows dynamic list
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes
- [ ] No regressions in existing integration functionality (GSuite tools callable)
