# OS shell: window manager & store

The desktop shell is a thin React layer over a **Zustand vanilla store**, seeded
on the server and hydrated on the client.

---

## The store (`src/store/os-store.ts`)

`createOSStore(init)` returns a Zustand vanilla store. State:

- `windows: WindowInstance[]`, `focusedId: string | null`, `zCounter: number`
- `settings: OSSettings`, `apps: AppManifest[]`

Actions:

| Action | Purpose |
|---|---|
| `launch(appId, params?) → id\|null` | Open a window. If the app is `singleton` and already open, focuses it (merging `params`). |
| `close(id)` / `minimize(id)` / `focus(id)` | Window lifecycle. `focus` bumps `zIndex` and un‑minimizes. |
| `move(id,x,y)` / `resize(id,bounds)` / `toggleMaximize(id)` | Geometry (clamped: min 280×180; below the top bar). |
| `setTitle(id,title)` | Rename a window (apps set their own titles, e.g. Files/Browser). |
| `applySettings(patch)` | Update OS settings **in the store** (persist separately via `settingsClient`). |
| `registerApp(app)` / `unregisterApp(id)` | Add/remove an app at runtime (live desktop/dock refresh; `unregisterApp` also closes its windows). |

New window ids are `"<appId>-<base36 time>-<rand>"`; launch positions cascade.

---

## Provider & hooks (`src/store/os-provider.tsx`)

`<OSProvider settings apps>` creates the store once and exposes it via context.

- `useOSStore(selector)` — subscribe to a slice.
- `useOSStoreApi()` — get the store API for fresh reads in callbacks
  (`useOSStoreApi().getState()`).

---

## SSR seeding (`src/app/page.tsx`)

`page.tsx` is `dynamic = "force-dynamic"`. It server‑reads `getSettings()` and
`listInstalledManifests()`, concatenates with `BUILTIN_APPS`, and passes both to
`<OSProvider>`. Keep the **first client render identical** to the server markup —
don't seed client‑only state that changes initial output (hydration mismatch is a
known hazard; the e2e baseline guards against it).

---

## AppManifest (`src/os/types.ts`)

```ts
interface AppManifest {
  id: string; name: string; icon: string;      // icon = a lucide-react name
  defaultWidth: number; defaultHeight: number;
  order?: number;                                // desktop/dock sort key
  singleton?: boolean; builtin?: boolean;
  kind?: "builtin" | "iframe";                   // how it renders
  url?: string;                                  // iframe apps: /apps/<id>
  source?: string;                               // installed apps: dir
}
```

---

## Rendering a window (`src/components/desktop/Window.tsx`)

- `kind === "iframe"` → `<IframeApp>` loads `manifest.url` (installed apps).
- otherwise → look up a React component via `getAppComponent(appId)` in
  `src/components/apps/registry.tsx` (built‑in apps).

Built‑in app components receive `AppProps` `{ windowId, appId, params }`.

---

## Desktop chrome

`Desktop.tsx`, `Dock.tsx`, `Topbar.tsx`, `WindowManager.tsx`, `icons.tsx`,
`FirstRunWizard.tsx`, `VersionControls.tsx`.

- **Icons**: `<AppIcon name=… />` maps a manifest's `icon` string to a
  lucide‑react component (with a fallback). Use a name that exists in that set.
- **Text selection**: only chrome gets `select-none`. **Never** disable selection
  globally — app content must stay selectable.
- **Topbar** hosts `<VersionControls>`, which renders nothing unless served through
  the Supervisor. See [Live version control](../self-modification/live-version-control.md).
- **FirstRunWizard** posts to `/api/system/setup` and seeds the `ai-provider`,
  `dev-harness`, and `datafs` config namespaces; it reads `/api/datafs` for the
  compatible isolation methods.
