# Installed apps (the `app/` facet of an Item)

An **Item** is the unit of installation (user-specs/002-service-daemons): a
self-contained folder that may bundle any mix of `app/` (UI), `services/`,
`hooks/`, `config/`, `spec/`, `doc/`. There is **one** install mechanism for
every item shape: the item's content lives under `dataDir()/user-apps/<id>/`
(the user's own GitFS repo, aka the local marketplace) and each present facet
is **symlinked** into `dataDir()/system/<type>/<id>` (see
`src/system/marketplace/install/symlinkManager.ts`). An "installed app" is
simply an item whose `app/` is linked at `dataDir()/system/app/<id>`; it
renders as a sandboxed **iframe** at `/apps/<id>`.

There is no separate apps repo and no `appsDir()`/`BOS_APPS_DIR` anymore.

---

## Where they live

- Content: `dataDir()/user-apps/<id>/app/` — part of the item, versioned in the
  user-apps GitFS repo (`src/lib/gitfs/store.ts`: `ensureRepo`, `commitAll`).
- Install marker: the `dataDir()/system/app/<id>` symlink. Installed =
  symlink exists; soft-uninstalled = files kept, symlink removed.
- **No central registry.** The desktop discovers apps by **listing
  `dataDir()/system/app/`**; Settings → Apps lists all app-carrying items under
  `user-apps/` (installed and restorable). Metadata lives in an optional
  `app/app.json` (`name, icon, createdAt, entry?, capabilities?, origin?,
  marketplaceId?`); items without one (e.g. a service item that ships a UI)
  fall back to their `services/service.json` name.

---

## Store & lifecycle (`src/lib/apps/store.ts`)

- `installApp({ name, icon?, files, entry? }, { draft? })` — the assistant's
  path: writes files into `user-apps/<id>/app/`, optionally builds, writes
  `app.json`, commits to the user-apps repo, creates the `system/app/<id>`
  symlink. `draft:true` under the Supervisor lands the content on the
  `app-candidate` branch of the **user-apps repo** (preview).
- `installItemApp(id, meta?)` — the marketplace path: the item is already under
  `user-apps/<id>/`; writes/updates its `app.json` (provenance: remote
  marketplace installs get `origin:"marketplace"` → opaque-origin sandbox;
  local items are the user's own → same-origin) and creates the symlink.
- `uninstallApp(id)` — soft: removes the symlink, **keeps files**.
- `restoreApp(id)` — recreates the symlink.
- `purgeApp(id)` — deletes `user-apps/<id>/` and commits. Refuses while the
  item's service is still installed (uninstall the service first).
- `listInstalledManifests()` → apps discovered from `system/app/` symlinks
  (dangling links, e.g. after a discarded draft, are skipped), as iframe
  `AppManifest`s (SSR-seeded by `src/app/page.tsx`).
- `pickIcon(name, spec)` auto-selects a lucide icon by keyword (default `Puzzle`).

API: `/api/apps` (GET list, POST install, DELETE uninstall/`?purge=1`, PATCH
restore), `/api/apps/build` (POST — build & install a project), and
`/api/marketplace` `op:"install-item"` (installs every facet of an item —
app and/or service — in one call).

---

## App shapes

- **Static app** — `app/` with `index.html` (+ assets), served as-is.
- **Project app** — a multi-file TS/TSX project bundled at install time.
  `app.json` carries `entry` (e.g. `src/main.tsx`).

### Build (`src/lib/apps/build.ts`)

- `buildAppDir(appDir, entry, name)` — **esbuild** bundles `<appDir>/<entry>` into
  `<appDir>/dist/{bundle.js, bundle.css?}` and generates a `dist/index.html` shell
  (`<div id="root">` + the bundle). A path-escape guard keeps `entry` inside the app
  dir; a build error throws so a broken app never silently installs.
- **Deps are "provided", not per-app installed.** esbuild resolves bare imports
  (`react`, …) against **BOS's own `node_modules`** via `nodePaths`. There is **no
  per-app `npm install`** (and thus no install-script surface). `format:"iife"`,
  `jsx:"automatic"`, `minify`, assets as data URLs.
- `readProjectDir(dir)` reads an agent-authored staging dir into `{ relPath:
  content }` (skips `node_modules`/`.git`/`dist`, binaries, oversized files; capped).

---

## Serving (`src/app/apps/[...slug]/route.ts`)

- Reads through the `dataDir()/system/app/<id>` symlink. If `dist/index.html`
  exists → serve from `dist/` (built output); else serve the app dir (static).
  **Project source is never served.**
- A **path-escape jail** resolves the target under the chosen root (load-bearing —
  it reads the filesystem directly), plus an id-format guard.
- HTML gets a `<base href="/apps/<id>/">`, the inlined BOS SDK, the app's
  persisted storage snapshot, and inlined `bundle.css`/`bundle.js` injected (no
  sub-resource requests — required for opaque-origin sandboxed iframes).
- Service items that bundle a UI are opened the same way (Settings → Services
  "Open App" opens `/apps/<id>/`).

---

## Authoring flow (the assistant)

There is **no "Dev Studio" app**; apps are created via the Developer sub-agent +
install:

- **Simple/static:** delegate to `developer` with `contentOnly:true` to produce one
  self-contained `index.html`, then `installApp({ name, files:{ "index.html": … }
  })`.
- **Project:** delegate (`contentOnly:true`) to **write** the project into a staging
  dir (no build/install), then call `buildApp` (`/api/apps/build` → `readProjectDir`
  → `installApp({ files, entry }, { draft:true })`).

`contentOnly:true` keeps it a **content** operation (no BOS-code preview worktree)
— see [Sub-agents](../assistant/sub-agents-and-delegation.md). Preview / promote /
discard for apps is the GitFS `app-candidate` branch of the **user-apps repo**
(served branch-live by base, no extra port) — see
[Live version control](../self-modification/live-version-control.md).
