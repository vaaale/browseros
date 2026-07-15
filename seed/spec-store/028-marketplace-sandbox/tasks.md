# Tasks: 028 Marketplace + Sandboxed Apps

Feature branch: `028-marketplace-sandbox`. **Depends on `027` Phases 1–3.** `[P]` = parallelizable; `[T]` = test task.

## Phase 1 — App Provider Registry (manifest vs. component split)

- [ ] P1.1. `src/lib/apps/provider.ts` (new) — `AppProvider` + `AppRegistry` (manifests only). Extend `AppManifest` (`runtime`, `source`, `marketplaceId`, `marketplaceItemId`, `canAdoptSpec`).
- [ ] P1.2. Back-compat (N7) — manifests missing `runtime`/`source` default to `runtime:'iframe'`, `source:'local'`.
- [ ] P1.3. [P] `providers/builtin.ts` — wraps `_manifests.generated`; `runtime:'native'`, `source:'builtin'`.
- [ ] P1.4. [P] `providers/local.ts` — scans `data/apps/local/` `app-manifest.json`; `runtime:'iframe'`.
- [ ] P1.5. [P] `providers/marketplace.ts` — parses `marketplace.json` from `data/apps/marketplace/<id>/`; `runtime:'iframe'`.
- [ ] P1.6. `src/os/apps.ts` (modify) — manifest list from `AppRegistry`; SSR seed uses it server-side.
- [ ] P1.7. Window renderer — branch on `runtime`: `native` → `getAppComponent(id)` (static, **`registry.tsx` unchanged**); `iframe` → sandboxed iframe. Enforce `native ⇒ builtin`.
- [ ] P1.8. [T] Unit test — legacy manifest without `runtime`/`source` resolves with defaults and opens.
- [ ] P1.9. `npx tsc --noEmit` + `npm run lint` green.

## Phase 2 — Opaque-origin sandbox + iframe SDK library + `storage`

- [ ] P2.1. Opaque-origin sandbox — render untrusted (local + marketplace) apps with `sandbox` **without** `allow-same-origin`. Keep native/first-party trusted apps same-origin. Confirm `e.source` check (`IframeApp.tsx:83`) holds for opaque frames.
- [ ] P2.2. iframe SDK library — new `src/lib/iframe-sdk/` TS source; `tools/build-sdk.mjs` (esbuild) → served artifact; rewrite `src/app/__bos/sdk.js/route.ts` to read the artifact.
- [ ] P2.3. SDK surface — `storage` namespace, ready-promise, capability introspection, error types, over the existing `call()` transport.
- [ ] P2.4. `storage` capability (server) — broker `storage:get/set/remove/keys` backed by per-app `data/app-storage/<appId>/`; capability-gated (extend `CAP_FOR_METHOD` + `dispatch` in `IframeApp.tsx`).
- [ ] P2.5. `localStorage`/`sessionStorage` shim (SDK) — `Object.defineProperty(window, 'localStorage', …)`; **synchronous hydrate (N3)**: serving route inlines `window.__bos_storage_snapshot` in a bootstrap before the static SDK; sync reads; async write-through; flush on `pagehide`/`visibilitychange`. `sessionStorage` in-memory. IndexedDB not shimmed.
- [ ] P2.6. Asset CORS (N3) — permissive CORS on the app's own static-asset route; BOS `/api/*` grants none.
- [ ] P2.7. Serving route — extend `src/app/apps/[...slug]/route.ts` (or sibling) to serve `data/apps/local/` and `data/apps/marketplace/<id>/`.
- [ ] P2.8. [T] Tests — opaque app cannot reach BOS except via broker; ungranted `storage` call rejected; `storage` namespace isolation between apps; `localStorage` shim **synchronous** round-trip (startup read returns persisted value, not cold `null`); own-asset fetch succeeds while `/api/*` fetch fails.
- [ ] P2.9. `npx tsc --noEmit` + `npm run lint` green.

## Phase 3 — Marketplace (client + providers + adopt/install/lifecycle)

- [ ] P3.1. `src/lib/marketplace/schema.ts` (new) — `MarketplaceManifest`, `MarketplaceItem`, `RegisteredMarketplace`.
- [ ] P3.2. `src/lib/marketplace/client.ts` (new) — `addMarketplace` (**git-URL allowlist** `https://`/optional `ssh`; reject `file://`/`ext::`; `execFile` clone; **schema-validate** before use), `syncMarketplace`, `listItems`, `adoptSpec` (fork into 027 user store; **id de-dup suffix, N7**; commit), `installApp`.
- [ ] P3.3. Lifecycle — `removeMarketplace` (unregister + delete clones; leaves adopted specs), `uninstallApp` (delist + delete local copy). Confirmations.
- [ ] P3.4. [T] Unit test — git-URL allowlist rejects `file://`/`ext::`/unknown; malformed `marketplace.json` rejected before clone; adopted-id collision appends suffix.
- [ ] P3.5. `src/app/api/marketplace/route.ts` (new) — list / add / remove / sync / adopt-spec / install-app / uninstall-app.
- [ ] P3.6. `src/apps/marketplace/manifest.ts` + `index.tsx` (new) — three-panel UI: marketplaces + add; item grid (search/filter); detail with Run/Install/Adopt/Uninstall.
- [ ] P3.7. [T] e2e — register a local repo as marketplace; list items; adopt a spec; run a sandboxed app.
- [ ] P3.8. `npx tsc --noEmit` + `npm run lint` green.

## Closeout

- [ ] C1. Update `009-installed-apps` to the three-source model.
- [ ] C2. Update `overview.md`, `docs/dev/architecture-overview.md`.
- [ ] C3. Update `docs/usage/` — Marketplace, sandbox trust model, SDK/storage for app authors.
