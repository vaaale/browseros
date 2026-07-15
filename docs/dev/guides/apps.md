# BOS App Guide

How to design and build a solid app in BrowserOS. This guide covers both **built-in apps** (compiled into the BOS bundle) and **installed apps** (sandboxed GitFS content), with an emphasis on architecture, separation of concerns, and user-facing quality.

Related reading: [Style guide](./style-guide.md) · [Features & components guide](./features-and-components.md) · [Design heuristics](../design-heuristics.md) · [Architecture overview](../architecture-overview.md) · [Installed apps reference](../apps/installed-apps.md) · [Built-in apps reference](../apps/built-in-apps.md).

---

## 1. What kind of app are you building?

### Built-in app

A first-class React component in `src/apps/<id>/`, compiled into the BOS bundle. Use this when the app needs tight OS integration, direct access to BOS APIs, or must ship with the OS itself.

Examples: Files, Settings, Build Studio, Assistant.

### Installed app

A standalone project or static site living in the GitFS apps repo (`./apps/<id>/`), rendered in a sandboxed iframe at `/apps/<id>`. Use this for user-facing or third-party apps that should be versioned independently and installed without changing BOS source.

Examples: user-created tools, experimental UIs, content apps.

### Decision checklist

- Needs direct OS state, settings, or internal APIs? → **Built-in**.
- Should be installable/promotable without a BOS build? → **Installed**.
- Is the UI primarily a thin wrapper around a BOS subsystem? → **Built-in**.
- Is it a self-contained user tool with its own lifecycle? → **Installed**.

### Trust tiers, the SDK & sandbox (028)

Installed/iframe apps reach BOS ONLY through the **iframe SDK** — `window.__bos`,
served from `/api/iframe-sdk` and auto-injected into every app's HTML by the
`/apps/[...slug]` route. It is a promise-based wrapper over a `postMessage`
broker (`IframeApp.tsx`); a call succeeds only if the app's manifest **granted**
that `AppCapability` (`fs:read`/`fs:write`/`settings:read`/`notify`/`window:title`/
`storage`). `window.__bos.storage.{get,set,remove,keys}` is a per-app KV
(`/api/app-storage`, namespaced by the app id the *parent* supplies — never the
iframe). The SDK also shims `localStorage`/`sessionStorage` over `storage`, but
ONLY when native storage is unavailable (opaque origin); same-origin apps keep
native storage.

Provenance (`AppManifest.origin`) sets the sandbox:

| Tier | `origin` | Sandbox | BOS access |
|---|---|---|---|
| Built-in | (native) | n/a (React) | anything |
| Installed, local | `local` | same-origin | broker + (today) same-origin |
| Marketplace | `marketplace` | **opaque-origin** (no `allow-same-origin`) | broker only |

Marketplace apps are untrusted, so they run opaque-origin: the broker is their
only channel, and the `storage` shim backs their `localStorage`.

---

## 2. Anatomy of an app

### Built-in

```
src/apps/<id>/
  manifest.ts   # AppManifest: id, name, icon, default size, singleton, order
  index.tsx     # default-export React component taking AppProps
```

No central registry to edit — `tools/gen-apps.mjs` discovers folders on `predev`/`prebuild`.

### Installed

```
apps/<id>/
  app.json      # id, name, icon, status, entry?
  index.html    # static app
  # or
  src/main.tsx  # project app entry
  dist/         # built output
```

Installed apps are built with esbuild against BOS's own `node_modules`; there is no per-app `npm install`.

---

## 3. Design principles

### One app = one coherent surface

An app window should do one thing well. If you find yourself adding tabs for unrelated concerns, split the app or use Settings tabs / separate windows.

### Prefer OS primitives over custom chrome

- Use the existing window manager, title bar, and modal patterns.
- Don't draw your own window controls.
- Don't invent a second routing/navigation system inside an app unless the domain genuinely needs it.

### Keep app state close to the surface

- UI state belongs in the component or a lightweight hook.
- Cross-window or persistent state belongs in the OS store, a server-only store, or a config namespace.
- Never put business logic directly in event handlers; extract hooks/services.

### Text-selectable content

App content should be selectable. Only chrome (title bars, dock, etc.) uses `select-none`.

### Respect SSR/hydration

See [Design heuristics](../design-heuristics.md). All interactive components must be `"use client"`. Don't compute random IDs or timestamps during render; do it in `useEffect` or derive from stable props.

---

## 4. Layout & UI

See the [Style guide](./style-guide.md) for the exact Tailwind recipes. The two non-negotiables for an app shell:

```tsx
<div className="flex h-full flex-col">
  {/* header/toolbar: shrink-0 */}
  <div className="flex shrink-0 ...">...</div>
  {/* scroll body */}
  <div className="min-h-0 flex-1 overflow-auto ...">...</div>
</div>
```

`min-h-0` on the scroll region is required — without it, the flex child won't shrink and scrolling breaks.

---

## 5. State management

### Reading OS state

```tsx
const launch = useOSStore((s) => s.launch);
```

Always use selectors. Never pull the whole store into a component.

### Setting the window title

```tsx
const setTitle = useOSStore((s) => s.setTitle);
useEffect(() => {
  setTitle(windowId, title);
}, [title, setTitle, windowId]);
```

### Persistence

- **Client-only state** — Zustand or React state.
- **User settings / configuration** — add a `ConfigRegistration` in `src/lib/config/registry.ts`.
- **Domain data** — create a `server-only` store under `src/lib/...`, write atomically under `data/...`, expose an `/api/...` route, and call it with `fetch` from the client.

For installed apps, persistence is up to the app; it can call BOS APIs or store data in its own GitFS directory.

---

## 6. Exposing assistant tools

Apps can offer tools to the assistant through the two-tier system:

### Tier 1 — installed-app tools

Static tools declared by the app, permissioned per agent in **Settings → Agents → [agent] → Tools**. Grouped by app name.

- Declare the capability in the app's manifest or a static `agent-tools.ts`.
- Register it in the capabilities inventory.
- Implement the handler in the app or server.

Example use case: the Scheduler app exposes `scheduler_task_create` and `scheduler_task_list`.

### Tier 2 — runtime surface tools

Dynamic tools available only when the app's window is open. Registered via `registerAppSurfaceTools` in the app component. Dispatched to the correct window.

Example use case: the UI Preview app exposes `ui_preview_render` while its window is open.

See [Features & components guide](./features-and-components.md) for the registration mechanics.

---

## 7. Recipes

### Add a built-in app

1. `src/apps/<id>/manifest.ts` — export an `AppManifest`. Folder name must equal `id`.
2. `src/apps/<id>/index.tsx` — `"use client"`, default-export an `AppProps` component.
3. Run `npm run gen:apps` (or let `predev`/`prebuild` do it).
4. Add persistence/APIs if needed.
5. If the app exposes tools, register them in the capabilities inventory.

### Add an installed app

1. Author the app as a static folder or a TS/TSX project in a staging directory.
2. For a project app, ensure `entry` points to the main TSX file.
3. Delegate installation to `installApp` or call `/api/apps/build` then `/api/apps`.
4. Preview/promote via the GitFS `app-candidate` branch.

---

## 8. Testing & quality

- `npx tsc --noEmit` must pass.
- `npm run lint` must pass.
- Verify the app shell scrolls correctly at small and large window sizes.
- Test that the app works when launched with `bos_app_launch` from the assistant.
- If the app exposes tools, test them from an agent run.

---

## 9. Common pitfalls

- **Missing `min-h-0`** on the scroll region → broken scrolling.
- **Client-only initial state** → hydration mismatch.
- **Grabbing the whole OS store** → unnecessary re-renders.
- **Adding a UI dependency** — BOS has no component library; inline Tailwind only.
- **Confusing installed vs built-in persistence models** — installed apps cannot write to BOS source stores directly.
