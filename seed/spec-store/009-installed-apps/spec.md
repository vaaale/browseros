# Feature Specification: Installed Apps (Buildable App Projects)

**Feature Branch**: `009-installed-apps`

**Created**: 2026-06-28 (migrated from `spec/self-modification/apps.md`)

**Status**: Implemented

> **Extended by `028-marketplace-sandbox`**: installed apps gain a third source
> (marketplace) and provenance (`AppManifest.origin`). The iframe SDK is served
> from `/api/iframe-sdk` and auto-injected; apps reach BOS only via the
> capability broker, with a per-app `storage` capability + `localStorage` shim.
> **Marketplace (untrusted) apps run in an opaque-origin sandbox** (no
> `allow-same-origin`) so the broker is their only channel; local/first-party
> apps keep the same-origin path. See 028 for the marketplace + sandbox model.

**Input**: "Installed apps are user-authored content rendered as a sandboxed iframe at /apps/<id>. An app may be a single static HTML file or a multi-file TypeScript/TSX project bundled at install time, so apps can be genuinely capable."

> Migrated from `spec/self-modification/apps.md`. Covers **installed** apps (GitFS content). Built-in apps are a different category (first-class React folders `src/apps/<id>/`, auto-discovered) defined by the constitution and per-app docs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - I can install a genuinely capable app (Priority: P1)

An app is either a single static HTML file or a multi-file TypeScript/React project bundled by esbuild at install time.

**Acceptance Scenarios**:

1. **Given** a multi-file project app, **When** it is installed, **Then** esbuild bundles it into `dist/` and it runs in a window.
2. **Given** a single static app, **When** it is installed, **Then** its `index.html` is served as-is.

### User Story 2 - App source is never served (Priority: P1)

For a project app, only the built `dist/` is served; the source files are unreachable.

### User Story 3 - The agent authors apps without touching the live apps repo (Priority: P2)

The Developer writes a project into a fresh staging directory; `buildApp` reads it, bundles, and installs it (as a draft → candidate).

### Edge Cases

- A build error MUST throw (with esbuild diagnostics) so a broken app never silently installs.
- Reading the staging dir is capped and text-only; `node_modules`/`.git`/`dist` are skipped.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Installed apps MUST be GitFS content (`007-gitfs`) rendered as a sandboxed iframe at `/apps/<id>`; built-in apps are a different category (React folders under `src/apps/<id>/`, auto-discovered).
- **FR-002**: An app MUST be either a **static** folder (`index.html` + assets, served as-is) or a **project** (`src/main.tsx`/`.ts` entry + components/CSS) bundled with esbuild into `dist/` at install; both live at `<appsDir>/<id>/` with an `app.json` manifest (`entry` present ⇒ project app).
- **FR-003**: `buildAppDir` MUST esbuild-bundle `<appDir>/<entry>` → `dist/{bundle.js, bundle.css?}` plus a generated `dist/index.html` shell, with a path-escape guard. Dependencies are **provided** — esbuild resolves bare imports against BOS's own `node_modules` via `nodePaths`; apps do NOT run `npm install`. Build uses `format: iife`, `jsx: automatic`, minify; a build error throws.
- **FR-004**: `installApp` MUST write `files` into `<appsDir>/<id>/`, run `buildAppDir` when `entry` is set, and commit to GitFS; `{ draft: true }` routes onto the app-candidate branch. Serving prefers `<id>/dist/index.html` (built) else `<id>/` (static), behind a path-escape jail — project source is never reachable.
- **FR-005**: Authoring a project MUST be decoupled from installing: the Developer (`contentOnly`) writes the project into a fresh staging directory (no build/install) → the orchestrator calls `buildApp` (`POST /api/apps/build` → `readProjectDir` → `installApp({ files, entry }, { draft: true })`). `readProjectDir` is capped and text-only and skips `node_modules`/`.git`/`dist`. Static apps keep the simpler `installApp({ html })` path.
- **FR-006**: The runtime trust boundary is the sandboxed iframe; the build only bundles provided code (no `npm install`, so no per-app install-script surface). Arbitrary per-app npm dependencies and a secrets `SecFS` are out of scope.

### Key Entities

- **App** — static or project, at `<appsDir>/<id>/`.
- **`app.json`** — manifest (`id, name, icon, createdAt, status, entry?`).
- **`buildAppDir` / `installApp` / `buildApp`** — the build + install paths.
- **Apps content repo** — the GitFS root (`BOS_APPS_DIR`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A multi-file React app installs and runs in a window.
- **SC-002**: A project app's source files are never served (only `dist/`).
- **SC-003**: The agent never writes the live apps repo directly — authoring goes through a staging dir + `buildApp`.

## Notes

- Apps live in the `007-gitfs` content repo and use its candidate (preview/promote/discard) flow; they are created via the Developer + `installApp`/`buildApp`. Built-in apps differ (BOS source, bundled React).
- Faithful migration of `spec/self-modification/apps.md`; original prose remains in git history.
