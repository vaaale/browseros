# BrowserOS Apps — Buildable App Projects — Specification

Installed apps are user-authored **content** (versioned in GitFS — see `spec/self-modification/gitfs.md`) rendered as a sandboxed iframe at `/apps/<id>`. An app may be either a **single static HTML file** or a **multi-file TypeScript/TSX project** bundled at install time. The project form exists so apps can be genuinely capable (components, TS, React), not limited to one inline HTML document.

## 1. App shapes

- **Static app:** a folder with `index.html` (+ optional assets), served as-is. No build.
- **Project app:** a folder with sources (`src/main.tsx` or `src/main.ts` entry, plus components/CSS/etc.) that BOS bundles with **esbuild** into `dist/` at install time. The built `dist/` is what's served; the source is never served.

Both live at `<appsDir>/<id>/` (the GitFS apps repo, `BOS_APPS_DIR`), with an `app.json` manifest (`id, name, icon, createdAt, status, entry?`). `entry` present ⇒ project app.

## 2. Build (`src/lib/apps/build.ts`)

- `buildAppDir(appDir, entry, name)`: esbuild bundles `<appDir>/<entry>` → `<appDir>/dist/{bundle.js, bundle.css?}` and generates a `dist/index.html` shell (`<div id="root">` + the bundle), with a path-escape guard keeping the entry inside the app dir.
- **Dependencies are "provided", not per-app installed.** esbuild resolves bare imports (`react`, `react-dom`, …) against **BOS's own `node_modules`** via `nodePaths`. Apps do **NOT** run `npm install` — so there is no per-app dependency tree and no install-script execution. (Arbitrary per-app npm deps are deliberately out of scope; see §5.)
- `format: "iife"`, `jsx: "automatic"`, `minify`, asset loaders as data URLs. esbuild is marked `serverExternalPackages` in `next.config.ts` so it runs in the Next server.
- A build error throws (with esbuild diagnostics) so a broken app never silently installs.

## 3. Install & serve

- `installApp({ name, icon, files, entry? })` (`src/lib/apps/store.ts`): writes `files` into `<appsDir>/<id>/`, and if `entry` is set, runs `buildAppDir`. Commits to GitFS. `{ draft: true }` routes it onto the app-candidate branch (preview) under the Supervisor.
- **Serving** (`src/app/apps/[...slug]/route.ts`): if `<id>/dist/index.html` exists, serve from `dist/` (built output); else serve `<id>/` (static). Source files of a project app are therefore never reachable. A path-escape jail applies to the chosen root.

## 4. Authoring flow (the agent)

A project is multi-file, so it is not passed through the chat as one string. Instead:
1. The assistant delegates to the **developer** sub-agent (`contentOnly: true`) to **write the project into a fresh staging directory** (entry `src/main.tsx`/`.ts`, components/CSS; may `import` provided deps; must NOT build or install) and report the directory path.
2. The assistant calls **`buildApp`** (`POST /api/apps/build` → `readProjectDir(dir)` → `installApp({ files, entry }, { draft: true })`). `readProjectDir` reads text files under the dir (skipping `node_modules`/`.git`/`dist`, binaries, oversized files; capped) — so authoring is decoupled from installing and the developer never writes into the live apps repo or `data/vfs/Apps`.

Single static apps keep the simpler path: developer returns one `index.html` → `installApp({ html })`.

## 5. Security boundary (current)

- **Runtime:** apps run in a sandboxed iframe; that is the runtime trust boundary (unchanged).
- **Build:** esbuild only *bundles* provided code — it does not execute the app, and there is **no `npm install`**, so there is no per-app install-script surface. Reading the staging dir is capped and text-only.
- **Out of scope (future):** arbitrary per-app npm dependencies (would reintroduce build-time install-script execution and needs sandboxing) and a `SecFS` for secrets. Not implemented.

## 6. Relationship to other specs

- **`spec/self-modification/gitfs.md`** — where apps live (the content repo) and the candidate (preview/promote/discard) flow `buildApp` installs into.
- **`spec/bos.md`** — apps are created via the Developer sub-agent + `installApp`/`buildApp`.
