# Installed apps (the `app/` facet of an Item)

An **Item** is the unit of installation (user-specs/002-service-daemons): a
self-contained folder that may bundle any mix of `app/` (UI), `services/`,
`hooks/`, `config/`, `spec/`, `docs/`. There is **one** install mechanism for
every item shape: the item's content lives under `dataDir()/user-apps/items/<id>/`
(the user's own GitFS repo, aka the local marketplace) and each present facet
is **symlinked** into `dataDir()/system/<type>/<id>` (see
`src/system/marketplace/install/symlinkManager.ts`). An "installed app" is
simply an item linked at `dataDir()/system/<id>` that carries an `app/` facet; it
renders as a sandboxed **iframe** at `/apps/<id>`.

There is no separate apps repo and no `appsDir()`/`BOS_APPS_DIR` anymore.

---

## Where they live

- Content: `dataDir()/user-apps/items/<id>/app/` — part of the item, versioned in the
  user-apps GitFS repo (`src/lib/gitfs/store.ts`: `ensureRepo`, `commitAll`).
- Install marker: the `dataDir()/system/<id>` item symlink. Installed =
  symlink exists; soft-uninstalled = files kept, symlink removed.
- **No central registry.** The desktop discovers apps by **listing
  `dataDir()/system/app/`**; Settings → Apps lists all app-carrying items under
  `user-apps/` (installed and restorable). Metadata lives in an optional
  `app/app.json` (`name, icon, createdAt, entry?, capabilities?, origin?,
  marketplaceId?`); items without one (e.g. a service item that ships a UI)
  fall back to their `services/service.json` name.

---

## The `docs/` facet

An item ships its own documentation, in the **same two-audience shape as BOS's
own `docs/`**, each audience namespaced by one folder named after the item:

```
<item>/docs/
├── usage/<Name>/…      # end-user pages
└── dev/<Name>/…        # developer/agent pages
```

`readFacets()` reports it as the `docs` facet, and `src/lib/docs/store.ts`
**overlays** every installed item's `docs/usage` and `docs/dev` onto BOS's own
two trees at read time — so `/api/docs` and the Docs app show an item's pages
alongside BOS's, with no build step and nothing written outside the item.

Rules that fall out of that:

- **Namespace by one folder, always.** Loose `.md` files directly under an
  item's `docs/usage/` land at the root of the shared tree and read as BOS
  pages. Name the folder after the item as a user sees it (`Workflows`, not
  `workflows` or `workflow-manager`) — it is a UI label.
- **BOS's own docs win a path collision**, and among items the lowest id wins,
  so an item can extend the tree but never shadow a BOS page. That's a
  tie-break, not a feature to design around — the per-item folder makes
  collisions impossible in practice.
- **No symlink into `docs/`.** Installed state is ONE symlink at `system/<id>`
  (035-install-by-symlink); a second artifact planted in the git-tracked source
  tree would dirty every worktree, be absent from feature-branch worktrees that
  didn't create it, and outlive an uninstall that only removes the one link.
  Pre-035 there was exactly such a symlink (`docs/external-docs/<id>`) with no
  reader at all — the overlay is what that link was missing.
- **The `/Docs` VFS mount is BOS source only.** It is branch-coupled and
  writable (writes ride a `bos/*` branch), which an item's read-only docs are
  not — so `file_read /Docs/usage/...` sees BOS's pages, not an item's. Item
  docs are authored in the item, by rebuilding it.
- **When a feature moves out of BOS core into an item, delete its `docs/`
  pages in the same change.** Two copies is the failure mode.

---

## Store & lifecycle (`src/lib/apps/store.ts`)

- `installItem({ name, icon?, files, entry? }, { draft? })` — the assistant's
  path: installs a full ITEM, not just an app. `files` keys are ITEM-ROOT-relative
  (`app/index.html`, `services/service.json`, `config/...`) — writes them under
  `user-apps/items/<id>/`, optionally builds the app facet's entry, writes
  `app/app.json` if an app facet is present, commits to the user-apps repo,
  creates the ONE `system/<id>` symlink, and — if a `services/service.json`
  facet is present — validates/registers/auto-starts it the same way a
  Marketplace-triggered service install does. At least one recognized facet
  (or an `entry`) is required; a services-only item (no `app/` at all) is
  valid. `draft:true` requires an active feature branch and lands the content on
  it: `installItem` resolves a `dataRoot` via `branchDataRoot()`
  (`src/lib/devharness/branch-data-root.ts`) — the branch's data clone when run
  from BASE, this process's own root inside a preview (already that clone) or
  with no Supervisor. Item files, the install symlink, seeded config and bundled
  assets all derive from that one root, so an install can't half-land. A service
  facet is validated but NOT started for a branch install: the branch's preview
  starts it on boot. You therefore stay on BASE for the whole job and switch to
  the Preview only to test — see
  [Live version control](../self-modification/live-version-control.md).
- `installItemApp(id, meta?)` — the marketplace path: the item is already under
  `user-apps/items/<id>/`; writes/updates its `app.json` (provenance: remote
  marketplace installs get `origin:"marketplace"` → opaque-origin sandbox;
  local items are the user's own → same-origin) and creates the symlink.
- `uninstallApp(id)` — removes the symlink. Files are kept on disk (so a
  `local`-origin item's content is never destroyed), but under 035 this is
  **final** — there is no restore action; reinstalling is a Marketplace action.
  Cascades to `uninstallService()` first if the item also has an installed
  service.
- `purgeApp(id)` — deletes `user-apps/items/<id>/` and commits. Only meaningful
  for `local`-origin items (nothing to purge for a marketplace-sourced one —
  remove the marketplace instead). Refuses while the item's service is still
  installed (uninstall the service first).
- `listInstalledManifests()` → apps discovered from the shared installed-item
  scan (`src/system/items/installed.ts`), filtered to items with an `app`
  facet (dangling symlinks, e.g. after a discarded draft, are skipped), as
  iframe `AppManifest`s (SSR-seeded by `src/app/page.tsx`).
- `pickIcon(name, spec)` auto-selects a lucide icon by keyword (default `Puzzle`).

API: `/api/apps` (GET list, POST install via `installItem`, DELETE
uninstall/`?purge=1` — no restore endpoint), `/api/apps/build` (POST — build &
install a staged item project), and `/api/marketplace` `op:"install-item"`
(installs every facet of an already-authored item — app and/or service — in
one call).

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

- Reads through the `dataDir()/system/<id>` item symlink. If `dist/index.html`
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

There is **no "Dev Studio" app**; apps (and services) are created via the
Developer sub-agent + install:

- **Simple/static app:** delegate to `developer` with `contentOnly:true` to produce
  one self-contained `index.html`, then `installItem({ name, files:{ "app/index.html": … }
  })` (`app_install` wraps this).
- **Project (app and/or service):** delegate (`contentOnly:true`) to **write** a
  staging directory whose root IS the item root — `app/` (e.g. `app/src/main.tsx`),
  `services/` (`service.json` + entry script), `config/` as needed — then call
  `app_build` (`/api/apps/build` → `readProjectDir` → `installItem({ files, entry? },
  { draft:true })`). Omit `entry` for a services-only item.

`contentOnly:true` keeps it a **content** operation (no BOS-code preview worktree)
— see [Sub-agents](../assistant/sub-agents-and-delegation.md). Preview / promote /
discard for apps is the feature branch's coupled **user-apps** worktree, promoted
and discarded together with the branch's code and specs (no extra port) — see
[Live version control](../self-modification/live-version-control.md).
