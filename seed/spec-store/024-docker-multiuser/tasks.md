---
description: "Task list for Docker Multi-User Deployment (024-docker-multiuser)"
---

# Tasks: Docker Multi-User Deployment (Bastion + Dynamic Instances)

**Input**: Design documents from `specs/bos-system-specs/024-docker-multiuser/`

**Prerequisites**: `plan.md` (required), `spec.md` (required for user stories)

**Tests**: Included — typecheck + lint required in both BOS and bastion; integration tests for provisioning; e2e for full login → proxy → BOS session flow.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel with the previous task(s) in the same phase (different files, no dependencies)
- **[Story]**: maps to a user story in spec.md (US1–US6)

---

## Phase 1: Setup & Scaffolding

- [ ] T001 Create the `bos/024-docker-multiuser` feature branch.
- [ ] T002 [P] Scaffold `bastion/` sub-project: `package.json` (Express, dockerode, jsonwebtoken, bcryptjs, js-yaml, openid-client, http-proxy-middleware, chokidar, cookie-parser), `tsconfig.json`, `src/index.ts` stub, `.gitignore` for `bastion/node_modules` and `bastion/dist`.
- [ ] T003 [P] Scaffold `bastion/ui/` Vite + React project: `package.json`, `vite.config.ts`, `src/main.tsx` stub, `/login`, `/admin`, `/account` route stubs.

---

## Phase 2: BOS Changes (Blocking for Integration)

**⚠️ Blocks Phases 5 and 6 (health check, BOS_DATA_ROOT used by provisioned containers).**

- [ ] T004 [US1] Add `BOS_DATA_ROOT` env var support to BOS: update `src/os/vfs.ts` (and any other `path.join(process.cwd(), 'data', …)` roots found by grep) to use `process.env.BOS_DATA_ROOT ?? path.join(process.cwd(), 'data')`. Single-user installs without the env var are unaffected.
- [ ] T005 [P] Add `src/app/api/health/route.ts` — `GET /api/health` returns `{ status: 'ok' }` HTTP 200; no auth, no side effects. Used by bastion `waitForHealthy`.
- [ ] T006 [P] Add `Dockerfile` at the repo root for the BOS image: multi-stage (deps via `npm ci`; runtime copies source and sets entrypoint). Entrypoint script: if `/app/node_modules/.bin` is absent, run `npm install`; then exec the Supervisor on `:8090`. Exposes port 8090.
- [ ] T007 [P] Run `npx tsc --noEmit` and `npm run lint` in BOS after T004–T005; fix any issues introduced.

**Checkpoint**: BOS image builds; `/api/health` responds; `BOS_DATA_ROOT` relocates all data writes.

---

## Phase 3: Bastion Core Infrastructure

**⚠️ Blocks all bastion user stories.**

- [ ] T008 Implement `bastion/src/config.ts`: typed `Config` object loaded from env vars + `/data/config.json` (env vars take precedence). Fields: `BOS_IMAGE`, `VOLUME_BASE`, `IDLE_TIMEOUT_MS` (default 1 800 000), `MAX_CONCURRENT_INSTANCES`, `BOS_BASE_REF`, `BASTION_AUTH_PROVIDER`, `JWT_SECRET`. Fail-fast on startup if `JWT_SECRET` is absent.
- [ ] T009 Implement `bastion/src/sessions.ts`: `issueSession(res, record)` signs and sets an HTTP-only `SameSite=Strict` JWT cookie; `verifySession(req)` validates and returns `{ username, groups, isAdmin }` or null; `clearSession(res)` clears the cookie.
- [ ] T010 [P] Implement `bastion/src/docker.ts`: dockerode wrapper exposing `createContainer`, `startContainer`, `stopContainer`, `removeContainer`, `inspectContainer`, `createVolume`, `removeVolume`, `listBosContainers`. All operations are typed, async, and throw on Docker API errors with descriptive messages. No shell-out.
- [ ] T011 Implement `bastion/src/lifecycle.ts`: per-user `InstanceState` map (in-memory, mirrored to `/data/instances.json`); in-flight provision `Map<username, Promise<void>>`; idle `setTimeout` per instance; `getOrProvision(username)` state machine; `reconcileOnStartup()` (list `bos-*` containers via docker.ts, adopt or clear stale map entries). MAX_CONCURRENT_INSTANCES check throws `CapacityError`.

**Checkpoint**: config, sessions, Docker SDK wrapper, and lifecycle state machine are implemented and type-check clean.

---

## Phase 4: Auth Providers (US2 + US3)

- [ ] T012 [US2] Implement `bastion/src/auth/simple.ts`: parse `{BASTION_DATA}/users.yaml` with `js-yaml`; validate passwords with `bcryptjs.compare`; use `chokidar` to watch and hot-reload the file; return `UserRecord | null`. Enforce username character restriction `[a-z0-9_-]` on load.
- [ ] T013 [US3] Implement `bastion/src/auth/keycloak.ts`: use `openid-client` to discover OIDC config from the issuer URL; implement Authorization Code + PKCE flow (`authorizationUrl`, `callbackParams`, `callback`); validate `id_token` via JWKS; extract username from configurable claim (default `preferred_username`); derive `isAdmin` from a configurable Keycloak role. Enforce username character restriction.
- [ ] T014 [P] [US2] Implement `bastion/src/auth/index.ts`: `AuthProvider` interface; `loadProvider(config)` factory returning the correct provider instance.
- [ ] T015 [P] [US2] Implement `bastion/src/routers/auth.ts`: `GET /login` (serve login page or redirect to Keycloak); `POST /login` (Simple: validate credentials → issue session → redirect to `/`); `GET /callback` (Keycloak: validate OIDC callback → issue session → redirect to `/`); `POST /logout` (clear session).
- [ ] T016 [P] [US2] Unit tests for Simple provider: correct credentials → UserRecord returned; wrong password → null; hot-reload adds a new user; invalid username chars → rejected.
- [ ] T017 [P] [US3] Unit tests for Keycloak provider: mock JWKS endpoint; valid token → UserRecord; expired/tampered token → null.

**Checkpoint**: both auth providers authenticate correctly; login/logout routes work; `BASTION_AUTH_PROVIDER` switch requires no code change.

---

## Phase 5: Container Provisioning (US1)

- [ ] T018 [US1] Implement `bastion/src/provision.ts`: `provisionUser(username, config)` — mkdir src/ and data/ under VOLUME_BASE, shallow `git clone` BOS_BASE_REF into src/, create `bos-nm-{username}` named Docker volume. `deprovision(username, opts: { wipeSrc, wipeData, wipeNm })` — stop container, selectively delete/re-clone src/, delete data/, remove/recreate nm volume. Implements all five FR-014 re-provision operations as named exports.
- [ ] T019 [US1] Wire `lifecycle.getOrProvision` to `provision.provisionUser` for first-time users; hook into `docker.ts` for `startContainer` + `waitForHealthy` (poll `GET http://bos-{username}:8090/api/health` at 2 s intervals up to configurable timeout).
- [ ] T020 [P] [US1] Integration tests (Docker SDK): provision a user → verify host dirs exist + nm volume exists + container created with correct mounts; deprovision with `wipeSrc=true, wipeData=false` → verify src/ re-cloned, data/ intact; concurrent provision for same user → single container created.

**Checkpoint**: first login provisions a working BOS container; re-provision operations behave correctly.

---

## Phase 6: Proxy + Idle Timeout (US1 + US6)

- [ ] T021 [US1] [US6] Implement `bastion/src/proxy.ts`: Express middleware for all non-bastion routes; verify session (→ 401 if missing); call `lifecycle.getOrProvision` (→ 503 with recovery link if fails); proxy via `http-proxy-middleware` to `http://bos-{username}:8090`; reset idle timer on each request; handle WebSocket upgrades (`server.on('upgrade', ...)`); catch proxy `error` events and return a styled HTML error page linking to `/account`.
- [ ] T022 [US6] Wire idle timeout in `lifecycle.ts`: `setTimeout(IDLE_TIMEOUT_MS, () => docker.stopContainer(...))` per instance; cleared and reset by `getOrProvision` on each proxied request; on fire, update `InstanceState.status = 'stopped'` and persist to `instances.json`.
- [ ] T023 [P] [US6] Integration test: provision a user; set IDLE_TIMEOUT_MS to 3000; wait 4 s; confirm container is stopped; make a proxied request; confirm container restarts and responds.

**Checkpoint**: authenticated requests are proxied to the correct BOS instance; idle instances stop; restart is transparent.

---

## Phase 7: Admin Page (US4)

- [ ] T024 [US4] Implement `bastion/src/routers/admin.ts`:
  - `GET /admin/users` — list users (Simple: from users.yaml; Keycloak: not applicable, returns 501 with note).
  - `POST /admin/users` — create user (Simple only); `DELETE /admin/users/:username`; `POST /admin/users/:username/reset-password`; `PATCH /admin/users/:username` (toggle isAdmin, block if last admin).
  - `GET /admin/instances` — list all instance states from lifecycle map.
  - `POST /admin/instances/:username/stop` — force-stop.
  - `POST /admin/instances/:username/reprovision` — admin-scoped re-provision (FR-015); body `{ operation }`.
  - `GET /admin/config` / `PUT /admin/config` — read/write `/data/config.json`.
  All routes guarded by `requireAdmin` middleware (403 if `session.isAdmin` is false).
- [ ] T025 [US4] Build `bastion/ui/src/pages/Admin.tsx`: four tabs — Users (sortable table + create/delete/reset-password modals), Instances (live-polling table with status badges + force-stop + re-provision buttons), Settings (form for all `config.json` fields with save), Auth (active provider indicator + Keycloak config fields). Confirm dialog for destructive operations (delete user + wipe data).
- [ ] T026 [P] [US4] e2e: log in as admin; create user via admin page; confirm user can log in; change IDLE_TIMEOUT via settings form; confirm new value is returned by `GET /admin/config`; force-stop an instance; confirm it appears stopped in the table.

**Checkpoint**: admin can manage users and instances via the UI; global settings persist across bastion restarts.

---

## Phase 8: User Self-Service Page (US5)

- [ ] T027 [US5] Implement `bastion/src/routers/account.ts`:
  - `GET /account/instance` — own instance status (from lifecycle map, username from session).
  - `POST /account/reprovision` — body `{ operation }` (one of `restart`, `reinstall_deps`, `reset_source`, `keep_data_full_reset`, `full_reprovision`); enforces own-instance-only; calls provision.ts operation. Returns 400 for `full_reprovision` if not confirmed (`{ confirm: true }` required in body).
  - `POST /account/password` — change own password (Simple provider only).
- [ ] T028 [US5] Build `bastion/ui/src/pages/Account.tsx`: instance status card (running/stopped/provisioning badge, last-active, uptime); re-provision panel — five operation cards with icons and descriptions; confirmation dialog for destructive ones (especially `full_reprovision` which requires typing the username to confirm).
- [ ] T029 [P] [US5] e2e: as a regular user, trigger `reset_source` (keep data); confirm src/ is re-cloned and data/ directory content is intact; attempt to access `/admin` → confirm 403.

**Checkpoint**: users can self-serve instance recovery without admin intervention; data survives source reset.

---

## Phase 9: Docker Compose & Deployment Files

- [ ] T030 Write `docker-compose.yml`: `bastion` service (build `./bastion`, port `${BASTION_PORT:-80}:3000`, mounts `/var/run/docker.sock`, `./bastion/data:/data`, `${VOLUME_BASE:-./user-data}:/user-data`, env block), `bos-net` bridge network (no BOS instance services).
- [ ] T031 [P] Write `docker-compose.dev.yml` override: mount `./bastion/src:/app/src` into bastion container for TS hot-reload (`ts-node-dev`); add Vite dev server sidecar on `:5173`; bastion proxies `/app/**` to Vite in dev mode.
- [ ] T032 [P] Write `docker-compose.keycloak.yml` override: add `keycloak` service (`quay.io/keycloak/keycloak:latest`, dev mode, pre-seeded realm JSON at `./bastion/keycloak/realm-export.json`) on `bos-net`; document in `.env.example` the Keycloak env vars the bastion needs.
- [ ] T033 [P] Write `.env.example` documenting every env var for bastion (`JWT_SECRET`, `BASTION_AUTH_PROVIDER`, `BOS_IMAGE`, `VOLUME_BASE`, `IDLE_TIMEOUT_MS`, `MAX_CONCURRENT_INSTANCES`, `BOS_BASE_REF`, Keycloak OIDC vars) and the single BOS var (`BOS_DATA_ROOT`).
- [ ] T034 [P] Write `bastion/Dockerfile`: multi-stage — `ui-build` (Vite build), `ts-build` (tsc), `runtime` (node:20-alpine, copies dist + built SPA + node_modules production only). CMD: `node dist/index.js`.

**Checkpoint**: `docker compose up` starts the bastion; `docker compose -f docker-compose.yml -f docker-compose.keycloak.yml up` starts bastion + Keycloak; no BOS containers appear until a user logs in.

---

## Phase 10: Polish & Cross-Cutting

- [ ] T035 [P] Full typecheck and lint pass: `npx tsc --noEmit` in `bastion/`; `npm run lint` in `bastion/`; `npx tsc --noEmit` in BOS root (confirming T004–T005 changes are clean).
- [ ] T036 [P] Write `docs/dev/deployment.md`: Docker Compose quick-start (build BOS image, configure `.env`, `docker compose up`); Simple auth setup (users.yaml format, bcrypt hashing); Keycloak setup (compose override + realm config); volume layout explanation; re-provisioning guide.
- [ ] T037 [P] Update `docs/dev/architecture-overview.md`: add bastion + multi-user topology diagram (ASCII); document the routing `browser → bastion:80 → bos-{user}:8090`; note `BOS_DATA_ROOT`.
- [ ] T038 [P] Update `CLAUDE.md`: note `bastion/` sub-project and its independent `package.json`/tsconfig; note `BOS_DATA_ROOT`; note that BOS Dockerfile exists at repo root.
- [ ] T039 Re-run Constitution Check and `/speckit.analyze` on 024 (spec ↔ plan ↔ tasks consistency).

---

## Dependencies & Execution Order

```
Phase 1 (scaffold)
  → Phase 2 (BOS changes) [parallel within phase]
  → Phase 3 (bastion core) [T008 → T009 → T010 → T011]
    → Phase 4 (auth)      [T012–T017, parallel within]
    → Phase 5 (provision) [T018 → T019 → T020]
      → Phase 6 (proxy)   [T021 → T022 → T023]
        → Phase 7 (admin) [T024 → T025 → T026]
        → Phase 8 (account) [T027 → T028 → T029]
  Phase 9 (compose files) [T030–T034, fully parallel once Phase 1 done]
  Phase 10 (polish)       [T035–T039, parallel, after all phases]
```

Phases 2 and 9 can proceed in parallel once Phase 1 is done. Phase 6 requires Phase 2 (health endpoint). Phases 7 and 8 can proceed in parallel once Phase 6 is done.

## Implementation Strategy

**MVP** = Phases 1 → 2 → 3 → 4 (Simple only) → 5 → 6 + docker-compose.yml (T030): a working single-auth multi-user deployment. Stop and validate before building the admin/account UIs or Keycloak.

Then: Phase 7 (admin UI) + Phase 8 (account self-service) + Phase 4 Keycloak (T013/T017) close the full feature.

Phase 9 (Keycloak compose override) and Phase 10 (docs) can be done last.

## Notes

- `[P]` = different files, no dependency on the preceding task in the same phase.
- Username character restriction `[a-z0-9_-]` is enforced at auth load time (Simple) and at OIDC claim extraction (Keycloak) — a claim value violating it causes a 400 with a clear error.
- The bastion never shells out to `git` or `docker` CLI — all subprocess operations go through `execFile` (for git clone only) or `dockerode` (for all Docker operations).
- `waitForHealthy` must retry with backoff and a hard timeout; a BOS container that fails to become healthy within the timeout causes a 503 with a recovery link, not a hung request.
- The last-admin guard in T024 must be enforced server-side (not just in the UI) — `PATCH /admin/users/:username` must count admin-flagged users before applying the change.
