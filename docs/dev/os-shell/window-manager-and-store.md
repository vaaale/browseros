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
| `launch(appId, params?, placement?) → id\|null` | Open a window. If the app is `singleton` and already open, focuses it (merging `params`). |
| `close(id)` / `minimize(id)` / `focus(id)` | Window lifecycle. `focus` bumps `zIndex` and un‑minimizes. |
| `move(id,x,y)` / `resize(id,bounds,opts?)` / `toggleMaximize(id)` | Geometry (clamped: min 280×180; below the top bar). |
| `togglePin(id)` | Always‑on‑top (see below). |
| `setTitle(id,title)` | Rename a window (apps set their own titles, e.g. Files/Browser). |
| `applySettings(patch)` | Update OS settings **in the store** (persist separately via `settingsClient`). |
| `registerApp(app)` / `unregisterApp(id)` | Add/remove an app at runtime (live desktop/dock refresh; `unregisterApp` also closes its windows). |

New window ids are `"<appId>-<base36 time>-<rand>"`; launch positions cascade.

**Nothing is persisted.** `windows` starts empty on every load and no app is
auto‑launched, so a reload leaves a bare desktop. Anything that should come back
after a refresh has to be re‑opened deliberately by whatever owns it.

### Sizing: the 80% rule and how to opt out

By default a window opens at `max(manifest default, 80% of the viewport)`, centred
with a cascade. That default is about how much room a *person* needs, so a manifest
asking for `defaultWidth: 320` still gets 80% of the viewport — declaring a small
size in the manifest does nothing.

Pass `placement` to `launch()` for windows whose geometry is dictated by their
**content** instead: any of `{ width, height, x, y }` is used verbatim and bypasses
the rule. The presence window (the agent's face) uses this to open small in the
upper‑left quadrant, then `resize(id, bounds, { exact: true })` to match the video
stream's aspect ratio — `exact` skips the 280×180 minimum, which exists to stop a
*user* dragging a window to nothing and would otherwise distort a small portrait
surface.

### Always‑on‑top

`WindowInstance.alwaysOnTop`, toggled by `togglePin(id)` from a pin button on the
**right** of the title bar (it occupies the spacer that balances the centred title,
so nothing shifts). An icon rather than a fourth traffic light, because it is a mode
that stays on rather than an action.

The z‑band is applied at render: `zIndex + 1_000_000` for pinned windows. Deliberately
not stored — `focus()` keeps handing out plain incrementing values and there is no
stacking state to keep consistent, so focusing an unpinned window can never bury a
pinned one.

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
  hidden?: boolean;                              // no dock/desktop entry; opened programmatically
  kind?: "builtin" | "iframe";                   // how it renders
  url?: string;                                  // iframe apps: /apps/<id>
  source?: string;                               // installed apps: dir
}
```

`hidden` is for windows that are not places the user *goes*: `html-viewer`,
`ui-preview`, and `presence` (the agent's face) are opened by other code, never
from an icon.

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
