# Implementation Plan: Marketplace + Sandboxed Apps

**Branch**: `028-marketplace-sandbox` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md) | **Tasks**: [tasks.md](./tasks.md)

**Depends on**: `027-vfs-specfs-marketplace` (mount table, SpecFS, Feature Context, Spec Provider Registry, `data/specs/` layout). Do not start until 027's Phases 1–3 have landed.

## Summary

Turn BOS's single compiled-in app list into a pluggable **three-source model** (builtin / local / marketplace) behind an async manifest **AppRegistry**, keeping the static native-component map (`registry.tsx`) unchanged. Contain untrusted (local + marketplace) apps in an **opaque-origin sandbox** so the `postMessage` capability broker is the only channel to BOS — no DNS/certs/ports. Promote the hard-coded iframe SDK to a **TypeScript library** (`src/lib/iframe-sdk/`) built with esbuild to a served artifact, adding a broker-backed **`storage` capability** (per-app namespace) and a `localStorage`/`sessionStorage` shim with **synchronous hydrate** (inlined per-app snapshot) so open-web storage apps work. Add a **Marketplace** (git-repo source) that delivers pre-built apps (Run/Install) and adoptable spec templates (Adopt → fork into `027`'s user store).

## Technical Context

**Dependencies**: esbuild (already present — `src/lib/apps/build.ts`), git via `execFile`. No new runtime deps anticipated.

**Storage** (fixed under `dataDir()`):
```
data/apps/local/                 ← user-developed local apps (app-manifest.json)
data/apps/marketplace/<id>/      ← canonical clone location for marketplace apps
data/specs/marketplace/<id>/     ← same clone reused for adoptable specs (027 layout)
data/config/marketplaces.json    ← registered marketplace URLs
data/app-storage/<appId>/        ← per-app storage namespace (broker `storage` capability)
```

**Server boundary**: marketplace clone/sync, provider discovery, `storage` persistence, and SDK artifact serving are server-only. The `storage` snapshot is rendered per-app-request into the bootstrap; the SDK library itself is a static artifact.

**Testing**: unit — git-URL allowlist, manifest back-compat defaults, adopted-id de-dup, `storage` namespace isolation; integration — opaque app cannot reach BOS except via broker, `localStorage` shim synchronous round-trip; e2e — register marketplace, run app, adopt spec.

## Constitution Check

- **I. Spec-Driven**: derives from `spec.md`. PASS.
- **II. Server Authority & SSR Boundary**: clone/persist/serve server-only; untrusted apps have no ambient BOS access — every call broker-mediated and capability-gated. PASS.
- **III. Always Delegate**: local-app *development* (editing code) remains out of scope; this feature is the runner + distribution. PASS.
- **IV. Minimize Blast Radius**: additive providers; `registry.tsx` unchanged; existing same-origin path retained for native/first-party; opaque-origin is the only new isolation mechanism (no infra). PASS.
- **V. VFS Is Not the Source**: adopted specs fork into `027`'s user store, never `src/`. PASS.
- **VI. Specs & Docs**: closeout updates `009`, `overview.md`, `docs/**`. PASS.
- **VII. Respect Boundaries**: git via `execFile`; destructive marketplace ops confirmed; no lockfile changes. PASS.

## Phase 1 — App Provider Registry (manifest vs. component split)

- **AppProvider / AppRegistry** (`src/lib/apps/provider.ts`): async, provider-aggregated **manifests only**. Extend `AppManifest` with `runtime`, `source`, `marketplaceId`, `marketplaceItemId`, `canAdoptSpec`. **Back-compat (N7):** manifests missing `runtime`/`source` default to `runtime:'iframe'`, `source:'local'`.
- **`registry.tsx` stays static** — native builtin components from `_components.generated`. Window renderer branches on `runtime`: `native` → `getAppComponent(id)`; `iframe` → sandboxed iframe. Enforce `native ⇒ builtin`.
- **BuiltinAppProvider / LocalAppProvider / MarketplaceAppProvider** — manifests for `_manifests.generated`, `data/apps/local/`, `data/apps/marketplace/<id>/`.
- **`src/os/apps.ts`** — manifest list from `AppRegistry`; SSR seed uses it server-side.

## Phase 2 — Opaque-origin sandbox + iframe SDK library + `storage`

- **Opaque-origin sandbox** (`IframeApp.tsx`): render untrusted apps with `sandbox` **without** `allow-same-origin`. Native/first-party trusted apps keep the same-origin path. Confirm the `e.source` identity check holds for opaque frames.
- **iframe SDK library** (`src/lib/iframe-sdk/`): TS source bundled by `tools/build-sdk.mjs` (esbuild) to a served artifact; `src/app/__bos/sdk.js/route.ts` reads the artifact instead of a hard-coded string. Surface: `storage` namespace, ready-promise, capability introspection, error types, over the existing private `call()` transport.
- **`storage` capability (server)**: broker methods `storage:get/set/remove/keys` backed by `data/app-storage/<appId>/` (per-app namespace); capability-gated (extend `CAP_FOR_METHOD` + `dispatch`).
- **`localStorage`/`sessionStorage` shim (SDK)**: `Object.defineProperty(window, 'localStorage', …)`; **synchronous hydrate (N3)** — the serving route inlines a per-app snapshot into a tiny bootstrap (`window.__bos_storage_snapshot`) served before the static SDK, so the `Map` is populated at parse time; sync reads; async write-through; flush on `pagehide`/`visibilitychange`. `sessionStorage` pure in-memory. IndexedDB not shimmed.
- **Asset CORS (N3)**: permissive CORS on the app's own static-asset route so it can fetch its bundled files; BOS `/api/*` grants none.
- **Serving route**: extend `src/app/apps/[...slug]/route.ts` (or a sibling) to serve `data/apps/local/` and `data/apps/marketplace/<id>/`, not only `appsDir()`.

## Phase 3 — Marketplace (client + providers + adopt/install/lifecycle)

- **Schemas** (`src/lib/marketplace/schema.ts`): `MarketplaceManifest`, `MarketplaceItem`, `RegisteredMarketplace`. Schema-validate before use.
- **MarketplaceClient** (`src/lib/marketplace/client.ts`): `addMarketplace` (**git-URL allowlist** `https://`/optional `ssh`; reject `file://`/`ext::`; `execFile` clone to canonical `data/…/marketplace/<id>/`), `syncMarketplace`, `listItems`, `adoptSpec` (fork into `027` user store; **id de-dup with suffix, N7**; commit), `installApp`.
- **Lifecycle**: `removeMarketplace` (unregister + delete clones; leaves adopted specs), `uninstallApp` (delist + delete local copy). Confirmations on destructive ops.
- **API** (`src/app/api/marketplace/route.ts`): list / add / remove / sync / adopt-spec / install-app / uninstall-app.
- **Marketplace app** (`src/apps/marketplace/`): three-panel UI — marketplaces + add; item grid (search/filter); detail with Run/Install/Adopt/Uninstall.

## Closeout

- Update `009-installed-apps` to the three-source model.
- Update `overview.md`, `docs/dev/architecture-overview.md`, `docs/usage/` (Marketplace, sandbox trust model, SDK/storage for app authors).
