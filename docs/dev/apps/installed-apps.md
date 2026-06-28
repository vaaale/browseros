# Installed apps (GitFS content)

Installed apps are **versioned content** in their own standalone git repo (GitFS),
**not** runtime state and **not** BOS source. They render as a sandboxed **iframe**
at `/apps/<id>`.

Specs: `specs/007-gitfs/spec.md`, `specs/009-installed-apps/spec.md`.

---

## Where they live

- Root: `appsDir()` (`src/os/apps-dir.ts`) = `BOS_APPS_DIR` or `<cwd>/apps`.
- A standalone git repo via `src/lib/gitfs/store.ts` (`ensureRepo`, `commitAll`,
  `history`). It checks for `<root>/.git` directly (never `git rev-parse`) so it can
  never accidentally operate on the enclosing BOS repo.
- **No central registry.** Each app is `<appsDir>/<id>/` with its files + an
  `app.json` (`id, name, icon, createdAt, status, uninstalledAt?, entry?`). Apps are
  discovered by **listing** the directory.

---

## Store & lifecycle (`src/lib/apps/store.ts`)

Each step commits to GitFS:

- `installApp({ name, icon?, files, entry? }, { draft? })` — write files into
  `<id>/`, optionally build (see below), write `app.json`, commit. `draft:true`
  under the Supervisor lands it on the `app-candidate` branch (preview).
- `uninstallApp(id)` — soft: `status:"uninstalled"`, **keeps files**.
- `restoreApp(id)` — back to `installed`.
- `purgeApp(id)` — remove the directory.
- `listInstalledManifests()` → only `installed` apps as iframe `AppManifest`s
  (SSR‑seeded by `src/app/page.tsx`).
- `pickIcon(name, spec)` auto‑selects a lucide icon by keyword (default `Puzzle`).

API: `/api/apps` (GET list, POST install, DELETE uninstall/`?purge=1`, PATCH
restore) and `/api/apps/build` (POST — build & install a project).

---

## App shapes (`specs/009-installed-apps/spec.md`)

- **Static app** — a folder with `index.html` (+ assets), served as‑is.
- **Project app** — a multi‑file TS/TSX project bundled at install time. `app.json`
  carries `entry` (e.g. `src/main.tsx`).

### Build (`src/lib/apps/build.ts`)

- `buildAppDir(appDir, entry, name)` — **esbuild** bundles `<appDir>/<entry>` into
  `<appDir>/dist/{bundle.js, bundle.css?}` and generates a `dist/index.html` shell
  (`<div id="root">` + the bundle). A path‑escape guard keeps `entry` inside the app
  dir; a build error throws so a broken app never silently installs.
- **Deps are "provided", not per‑app installed.** esbuild resolves bare imports
  (`react`, …) against **BOS's own `node_modules`** via `nodePaths`. There is **no
  per‑app `npm install`** (and thus no install‑script surface). `format:"iife"`,
  `jsx:"automatic"`, `minify`, assets as data URLs.
- `readProjectDir(dir)` reads an agent‑authored staging dir into `{ relPath:
  content }` (skips `node_modules`/`.git`/`dist`, binaries, oversized files; capped).

---

## Serving (`src/app/apps/[...slug]/route.ts`)

- If `<id>/dist/index.html` exists → serve from `dist/` (built output); else serve
  `<id>/` (static). **Project source is never served.**
- A **path‑escape jail** resolves the target under the chosen root (load‑bearing —
  it reads the filesystem directly).
- HTML gets a `<base href="/apps/<id>/">` injected so relative URLs resolve even
  though the iframe loads `/apps/<id>` (no trailing slash). Same‑origin, so apps can
  call BOS APIs.

---

## Authoring flow (the assistant)

There is **no "Dev Studio" app**; apps are created via the Developer sub‑agent +
install:

- **Simple/static:** delegate to `developer` with `contentOnly:true` to produce one
  self‑contained `index.html`, then `installApp({ name, files:{ "index.html": … }
  })`.
- **Project:** delegate (`contentOnly:true`) to **write** the project into a staging
  dir (no build/install), then call `buildApp` (`/api/apps/build` → `readProjectDir`
  → `installApp({ files, entry }, { draft:true })`).

`contentOnly:true` keeps it a **content** operation (no BOS‑code candidate worktree)
— see [Sub‑agents](../assistant/sub-agents-and-delegation.md). Candidate preview /
promote / discard for apps is the GitFS `app-candidate` branch — see
[Live version control](../self-modification/live-version-control.md).
