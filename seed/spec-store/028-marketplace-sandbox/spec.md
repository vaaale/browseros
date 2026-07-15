# Feature Specification: Marketplace + Sandboxed Apps — Three-Source App Model, Opaque-Origin Sandbox, iframe SDK Library

**Feature Branch**: `028-marketplace-sandbox`

**Created**: 2026-07-15

**Status**: Draft

**Depends on**: `027-vfs-specfs-marketplace` (VFS mount table, SpecFS, Feature Context, Spec Provider Registry, `data/specs/` layout).

**Input**: Split from `027` during design review (v2, N4). "Extend BOS to three sources of apps (builtin / local / marketplace). A marketplace is a git repo delivering pre-built apps and adoptable spec templates. Untrusted apps must run behind a real trust boundary — the capability broker must be the only channel to BOS. Promote the hard-coded iframe SDK to a proper library that gives apps a `storage` capability and a `localStorage`/`sessionStorage` shim so open-web apps work without native browser storage."

> This extends **009-installed-apps** from a single compiled-in list into a pluggable three-source model with an enforced sandbox. It reuses `027`'s Spec Provider Registry pattern and `data/specs/marketplace/` layout for the "adopt a spec" flow.

## Why this exists (context)

`027` fixed spec storage and made specs writable by any app. This feature opens the *other* half — where apps come from and how untrusted ones are contained.

**1. App discovery is static and closed.** The app list is a compiled-in manifest (`_manifests.generated`). There is no runtime path for user-developed apps or third-party apps.

**2. The existing iframe path is same-origin — the capability broker is decorative.** Installed apps are served from BOS's own origin (`src/app/apps/[...slug]/route.ts`) with `sandbox="… allow-same-origin"` (`IframeApp.tsx:118`). A hostile app can ignore the `postMessage` broker and call `/api/*` directly with the user's session. Tolerable for hand-installed first-party apps; unacceptable for a marketplace of stranger code.

**3. There is no distribution mechanism.** No way to publish, discover, install, or update apps and specs from an external source.

## Design decisions (carried from 027 review)

### Three-source app model
Apps come from three providers behind one registry (same pattern as `027`'s Spec Provider Registry):

| Source | Trust | Runtime | Origin |
|---|---|---|---|
| Builtin | full | `native` (compiled React) | in-bundle |
| Local (user-developed) | user's own | `iframe` | opaque-origin sandbox |
| Marketplace (third-party) | none | `iframe` | opaque-origin sandbox |

Invariant: `native ⇔ static import ⇔ builtin`; `iframe ⇔ dynamic ⇔ local/marketplace`. The static component map (`registry.tsx`) stays native-only; an async *manifest* registry drives everything else.

### Opaque-origin sandbox (the trust boundary — no infrastructure)
Untrusted apps render with `sandbox` **without** `allow-same-origin`, giving each frame a unique throwaway origin walled off from BOS and every other frame. The `postMessage` broker is the only channel; it already authenticates by `e.source === iframe.contentWindow` (`IframeApp.tsx:83`), correct for opaque frames (`e.origin === "null"`). No DNS, certs, or ports. A wildcard-subdomain origin remains a documented, unbuilt escape hatch only if unmodified open-web apps that need a stable browser origin become a requirement.

### iframe SDK as a TypeScript library + broker `storage`
Opaque origins have no browser storage, so:
- The SDK is promoted from a hard-coded string (`src/app/__bos/sdk.js/route.ts`) to a TS library (`src/lib/iframe-sdk/`) bundled to a served artifact (esbuild is already a dep — `src/lib/apps/build.ts`).
- A broker `storage` capability persists to a **per-app BOS-assigned namespace** in the user's data volume (capability-gated). Per-app namespacing gives app-to-app isolation *with* persistence despite opaque origins.
- The SDK installs a `localStorage`/`sessionStorage` shim over it.

### Adopt vs Run
A marketplace item can expose an `app/` (run pre-built), a `spec/` (adopt = fork into `027`'s `data/specs/user/`), or both. "Adopt" hands off to Build Studio; the fork has no ongoing link to the marketplace.

## Clarifications

### Session 2026-07-15 (from 027 review v2)

- Q: How are untrusted apps isolated with zero infrastructure? → A: Opaque-origin sandbox (`sandbox` minus `allow-same-origin`); broker is the only channel.
- Q: Opaque origins have no storage — how do apps persist? → A: Broker `storage` capability (per-app namespace) + SDK `localStorage`/`sessionStorage` shim.
- Q (N3): Do *unmodified* open-web apps "just work"? → A: **Not universally — claim tightened.** Two real limits: (a) `localStorage` is read synchronously at first script execution, so an async hydrate would return a cold `null`; (b) removing `allow-same-origin` breaks the app's own relative `fetch()`. Resolutions: (a) **synchronous hydrate** — inline a per-app storage snapshot into a tiny dynamic bootstrap served *before* the static SDK (`window.__bos_storage_snapshot = {…}`), so the shim's `Map` is populated at parse time (no cold cache, no silent `null`); (b) set permissive CORS on the app's *own static-asset* route so it can fetch its bundled files, while BOS `/api/*` grants none. Apps that use the broker for BOS access work; apps expecting direct same-origin BOS API calls need adaptation. This is documented, not hidden.
- Q (N7): Manifest back-compat? → A: Pre-028 GitFS-installed apps have manifests without `runtime`/`source`; default them to `runtime:'iframe'`, `source:'local'` so they still resolve.
- Q (N7): Adopted-store id collisions? → A: Adoption forks into `data/specs/user/<itemId>`; on collision, append a numeric suffix (`<itemId>-2`) and record the origin in the store manifest.
- Q: Marketplace URL safety? → A: Protocol allowlist (`https://` only, optional `ssh`); reject `file://`/`ext::`; schema-validate `marketplace.json` before use; clone via `execFile` (no shell).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Untrusted app is truly sandboxed (Priority: P1)

A marketplace app runs in an opaque-origin frame and can reach BOS only through granted capabilities.

**Independent Test**: Load an app that attempts `fetch('/api/fs')` directly and also calls `__bos.fs.read` via the SDK. Confirm the direct fetch fails (opaque origin, no cookies/CORS) and the brokered call succeeds only if `fs:read` is granted.

**Acceptance Scenarios**:
1. **Given** an opaque-origin app, **When** it calls a BOS API directly, **Then** the call fails.
2. **Given** a granted capability, **When** the app calls it via the SDK, **Then** it succeeds; an ungranted call is rejected by the broker.
3. **Given** two different apps, **When** each writes storage, **Then** neither can read the other's namespace.

### User Story 2 — Open-web `localStorage` app works, within stated limits (Priority: P1)

An app using `localStorage` runs sandboxed; its reads/writes persist via BOS, including a **synchronous read at startup**.

**Independent Test**: Load an app that reads `localStorage.getItem('k')` during initial synchronous module evaluation, then writes it. Confirm the startup read returns the previously-persisted value (synchronous hydrate via inlined snapshot), and the write persists across reload.

**Acceptance Scenarios**:
1. **Given** persisted storage, **When** the app reads synchronously at startup, **Then** it gets the real value (not a cold `null`).
2. **Given** a write, **When** the app reloads, **Then** the value persists (write-through + flush on `pagehide`).
3. **Given** an app that fetches its own bundled asset, **When** it runs, **Then** the fetch succeeds (asset-route CORS); a fetch to a BOS `/api/*` still fails.

### User Story 3 — Three-source app registry (Priority: P1)

The launcher lists builtin, local, and marketplace apps uniformly; native apps render as components, iframe apps in the sandbox.

**Acceptance Scenarios**:
1. **Given** apps from all three sources, **When** the launcher renders, **Then** all appear with correct metadata.
2. **Given** a builtin app, **When** opened, **Then** it renders via the static component map.
3. **Given** a pre-028 installed app manifest without `runtime`/`source`, **When** resolved, **Then** it defaults to `iframe`/`local` and still opens.

### User Story 4 — Marketplace: register, run, adopt (Priority: P2)

**Acceptance Scenarios**:
1. **Given** a registered marketplace, **When** the app loads, **Then** items render with Run / Install / Adopt actions per capability.
2. **Given** an item with a `spec`, **When** "Adopt" is clicked, **Then** it forks into `data/specs/user/` (de-duped id, N7) with a commit and Build Studio opens it.
3. **Given** a `file://`/`ext::` URL or malformed `marketplace.json`, **When** registration is attempted, **Then** it is rejected before any clone.

### User Story 5 — Marketplace lifecycle: remove / uninstall / un-adopt (Priority: P3)

**Acceptance Scenarios**:
1. **Given** an adopted spec, **When** its source marketplace is removed, **Then** the adopted spec is unaffected (adoption is a fork).
2. **Given** a marketplace with running apps, **When** removed (with confirmation), **Then** its clones are deleted and its apps are delisted.
3. **Given** an installed app, **When** uninstalled, **Then** it leaves the launcher and any local copy is deleted.
