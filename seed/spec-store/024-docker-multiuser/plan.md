# Implementation Plan: Docker Multi-User Deployment (Bastion + Dynamic Instances)

**Branch**: `024-docker-multiuser` | **Date**: 2026-07-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/bos-system-specs/024-docker-multiuser/spec.md`

## Summary

Add a `bastion/` sub-project to the BOS repo — a standalone Node.js/Express server that acts as the single ingress point for a multi-user Docker Compose deployment. The bastion authenticates users (Simple YAML file or Keycloak OIDC), dynamically provisions and routes to per-user BOS containers (each with its own `src/`, `data/`, and `node_modules` Docker volume), and exposes an admin page and user self-service page. BOS itself receives minimal changes: a `BOS_DATA_ROOT` env var for relocatable data, a health endpoint, and a Dockerfile. A `docker-compose.yml` at the repo root wires everything together; BOS instances are spawned at runtime by the bastion, not defined in Compose.

## Technical Context

**Language/Version**: TypeScript (Node ≥ 20) for the bastion; React + Vite for the admin SPA. Bastion's toolchain is independent of BOS's Next.js build.

**Primary Dependencies (bastion)**:
- `express` + `http-proxy-middleware` — HTTP + WebSocket proxy
- `dockerode` — Docker SDK (no shell-out to `docker` CLI)
- `jsonwebtoken` + `cookie-parser` — HTTP-only signed session cookies
- `bcryptjs` + `js-yaml` — Simple auth (YAML user store, bcrypt password hashing)
- `openid-client` — Keycloak OIDC (Authorization Code + PKCE, JWKS validation)
- `chokidar` — hot-reload `users.yaml` without bastion restart
- `react` + `vite` — admin/login/account SPA, served as static files from Express

**Primary Dependencies (BOS changes)**:
- No new deps; only `src/os/vfs.ts` and related path roots need a one-line env-var check.

**Storage**:
- Bastion runtime state: `/data/config.json` (global settings), `/data/instances.json` (container state, survives restarts), `/data/sessions/` (optional server-side session store for logout).
- Per-user volumes: `{VOLUME_BASE}/{username}/src/` and `{VOLUME_BASE}/{username}/data/` as bind mounts; `bos-nm-{username}` as a named Docker volume.

**Testing**: Integration tests for provisioning flow (Docker SDK calls); unit tests for auth providers (Simple: credential validation, YAML hot-reload; Keycloak: token validation mock); e2e for full login → proxy → BOS session flow and for each re-provision operation.

**Target Platform**: Docker Compose on a Linux host with Docker Engine ≥ 24 (rootful; rootless/socket-proxy is a later hardening option).

**Project Type**: New sub-project (`bastion/`) alongside the existing BOS Next.js project.

**Performance Goals**: Login → BOS session in < 30 s for a cold start (first provision); < 10 s for a warm start (stopped instance restart). Proxy overhead < 5 ms per request (pure pass-through after session check).

**Constraints**: Username characters restricted to `[a-z0-9_-]` (safe for container names, volume names, filesystem paths). Docker socket mount is in-scope for the deployment model (self-hosted / trusted operator). The last admin cannot lose the admin flag.

**Scale/Scope**: Designed for teams of up to ~50 concurrent users; no attempt to optimise for hundreds (that is a separate infrastructure concern).

## Constitution Check

*GATE: must pass before design; re-check after.*

- **I. Spec-Driven — SAAP**: plan derives from `spec.md`; implementation follows tasks.md. PASS.
- **II. Server Authority & SSR Boundary**: bastion is its own server process; BOS server boundary is unchanged. Bastion secrets (JWT signing key, OIDC client secret) live in env vars, never returned to the client. PASS.
- **III. Always Delegate; Claude Codes**: all implementation is source-code work → performed by the Developer (Claude) on a feature branch. PASS.
- **IV. Minimize Blast Radius (NON-NEGOTIABLE)**: bastion is a new sub-project (`bastion/`); BOS source changes are minimal (env var + health endpoint). No changes to `package.json`/lockfiles/build config of BOS. Feature branch is `024-docker-multiuser`. PASS.
- **V. The VFS Is Not the Source**: each user's `data/vfs` is in their own bind-mounted `data/` volume; not BOS source. PASS.
- **VI. Specs & Docs Stay in Sync (NON-NEGOTIABLE)**: this plan adds `docs/dev/deployment.md` (new) + updates `docs/dev/architecture-overview.md` and `CLAUDE.md`. PASS.
- **VII. Respect Boundaries**: `package.json`, lockfiles, and build config of BOS are untouched. The bastion has its own `package.json`. Docker socket access is an explicit, documented deployment choice. PASS.

No violations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/bos-system-specs/024-docker-multiuser/
├── spec.md        # done
├── plan.md        # this file
└── tasks.md       # next
```

### Source Code

```text
bastion/                              # NEW — self-contained sub-project
├── src/
│   ├── index.ts                      # Express server entry point; wires all routers + middleware
│   ├── config.ts                     # Runtime config: env vars + /data/config.json; typed Config object
│   ├── sessions.ts                   # JWT signing/verification; issue/revoke session cookie
│   ├── proxy.ts                      # http-proxy-middleware wiring; idle timer reset; error page on 502
│   ├── docker.ts                     # dockerode wrapper: createInstance, startInstance, stopInstance,
│   │                                 #   removeInstance, createVolume, removeVolume, isRunning,
│   │                                 #   waitForHealthy (polls :8090), reconcileOnStartup
│   ├── lifecycle.ts                  # Per-user state machine (idle timers, in-flight provision promises,
│   │                                 #   instances.json persistence); getOrProvision(username)
│   ├── provision.ts                  # Provision steps: mkdirs, git clone src/, create nm volume,
│   │                                 #   createContainer; re-provision operations (FR-014 matrix)
│   ├── auth/
│   │   ├── index.ts                  # AuthProvider interface: authenticate(req) → UserRecord | null;
│   │   │                             #   loadProvider(config) factory
│   │   ├── simple.ts                 # YAML + bcryptjs; chokidar hot-reload of users.yaml
│   │   └── keycloak.ts              # openid-client: Authorization Code + PKCE; JWKS token validation;
│   │                                 #   configurable username claim
│   └── routers/
│       ├── auth.ts                   # GET /login, POST /login, GET /callback (OIDC), POST /logout
│       ├── admin.ts                  # /admin/** API — users CRUD, instance table, global settings,
│       │                             #   auth config, force-stop, admin re-provision
│       └── account.ts               # /account/** API — own instance status, restart, re-provision
├── ui/                               # NEW — Vite + React SPA (served as static from Express)
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx                   # Router: /login, /admin, /account
│   │   └── pages/
│   │       ├── Login.tsx
│   │       ├── Admin.tsx             # User table, instance table, global settings form
│   │       └── Account.tsx          # Instance status, re-provision options with confirmation
│   └── vite.config.ts
├── Dockerfile                        # Multi-stage: build SPA → build TS → runtime image
├── package.json
└── tsconfig.json

src/                                  # BOS source — minimal changes
├── os/
│   └── vfs.ts                        # EDIT — respect BOS_DATA_ROOT env var (default ./data)
├── app/api/
│   └── health/route.ts               # NEW — GET /api/health → 200 (used by bastion waitForHealthy)
└── [any other path roots that hardcode ./data]  # EDIT — same BOS_DATA_ROOT pattern

Dockerfile                            # NEW — at repo root; BOS container image
docker-compose.yml                    # NEW — bastion + bos-net; no BOS instance services
docker-compose.dev.yml               # NEW — bastion src hot-reload override; Vite dev server proxy
docker-compose.keycloak.yml          # NEW — adds Keycloak service with pre-seeded realm
.env.example                          # NEW — documents all env vars
docs/dev/deployment.md               # NEW — multi-user Docker Compose deployment guide
docs/dev/architecture-overview.md    # EDIT — add bastion + multi-user topology
CLAUDE.md                             # EDIT — note bastion/ sub-project, BOS_DATA_ROOT
```

## Design Notes

### Config module (`bastion/src/config.ts`)

Loads typed config from env vars (required at startup) merged with `/data/config.json` (persisted global settings, written by the admin page). Exports a `getConfig()` function. Key fields: `BOS_IMAGE`, `VOLUME_BASE`, `IDLE_TIMEOUT_MS`, `MAX_CONCURRENT_INSTANCES`, `BOS_BASE_REF`, `BASTION_AUTH_PROVIDER`, `JWT_SECRET`, Keycloak OIDC fields. The admin page writes only to `config.json`; env vars override (twelve-factor discipline).

### Session management (`bastion/src/sessions.ts`)

Signed HTTP-only `SameSite=Strict` cookies containing a JWT payload: `{ username, groups, isAdmin, iat, exp }`. `JWT_SECRET` is a required env var (fail-fast on startup if absent). Session lifetime is configurable (default 8 h). Stateless by default; an optional `/data/sessions/` revocation store is a later hardening option. Logout clears the cookie client-side and removes the server-side entry if the store is active.

### Auth provider interface (`bastion/src/auth/index.ts`)

```ts
interface UserRecord { username: string; groups: string[]; isAdmin: boolean; }
interface AuthProvider {
  authenticate(username: string, password: string): Promise<UserRecord | null>;
  // Keycloak provider overrides the flow entirely via OIDC redirect; the interface
  // is used for Simple; Keycloak exposes its own callback route.
}
```

**Simple provider** (`simple.ts`): parses `users.yaml` with `js-yaml`; validates passwords with `bcryptjs.compare`; uses `chokidar` to watch the file for edits and reloads in-memory without a restart. Schema:
```yaml
users:
  - username: alice
    passwordHash: "$2b$10$..."
    groups: [admin]
  - username: bob
    passwordHash: "$2b$10$..."
    groups: []
```

**Keycloak provider** (`keycloak.ts`): uses `openid-client` to discover the Keycloak OIDC configuration from the issuer URL, run Authorization Code + PKCE, validate `id_token` via the JWKS endpoint, and extract `preferred_username` (or a configurable claim) as the BOS username. Admin flag derived from a configurable Keycloak role.

### Container lifecycle (`bastion/src/lifecycle.ts` + `docker.ts`)

`lifecycle.ts` owns all per-user mutable state:
- `Map<username, InstanceState>` in memory, mirrored to `/data/instances.json`
- `Map<username, Promise<void>>` for in-flight provisions (concurrent login race prevention)
- Per-instance `NodeJS.Timeout` for idle timer

`getOrProvision(username)`:
1. If already running → reset idle timer → return.
2. If stopped → `docker.startInstance` → `waitForHealthy` → reset idle timer → return.
3. If not yet provisioned → enter/await the in-flight promise → provision steps (see below) → start → wait → return.
4. If MAX_CONCURRENT_INSTANCES reached → throw (returns 503).

On bastion startup, `reconcileOnStartup()` lists all `bos-*` containers via the Docker SDK and reconciles state with `instances.json` (containers that exist but aren't in the map are adopted; map entries for non-existent containers are cleared).

### Provisioning (`bastion/src/provision.ts`)

Full provision (first login):
1. `fs.mkdirSync(VOLUME_BASE/username/src, { recursive: true })`
2. `fs.mkdirSync(VOLUME_BASE/username/data, { recursive: true })`
3. `execFile('git', ['clone', '--depth=1', BOS_BASE_REF_URL, VOLUME_BASE/username/src])` — shallow clone for speed; gives the user a full git repo to build on.
4. `docker.createVolume('bos-nm-{username}')`
5. `docker.createContainer('bos-{username}', { image: BOS_IMAGE, network: 'bos-net', mounts: [...], env: [BOS_DATA_ROOT=/app/data] })`
6. `docker.startInstance('bos-{username}')`
7. `waitForHealthy('bos-{username}', timeoutMs)`

Re-provision operations are compositions of stop → selective wipe → re-provision steps → start (see FR-014 matrix in spec).

### Proxy (`bastion/src/proxy.ts`)

Middleware applied to all routes not matched by `auth.*`, `admin.*`, `account.*`, or static file serving:
1. Verify session cookie → 401 if absent/invalid.
2. `await lifecycle.getOrProvision(session.username)` → 503 if fails.
3. Delegate to `http-proxy-middleware` targeting `http://bos-{username}:8090`.
4. For WebSocket upgrades: `proxy.upgrade(req, socket, head)` — HMR and CopilotKit streaming both traverse this path.
5. On `error` event from the proxy (container crashed mid-request): return a styled error page with a link to `/account` for recovery.

### BOS health endpoint (`src/app/api/health/route.ts`)

A minimal Next.js route returning `{ status: 'ok' }` with HTTP 200. No auth, no side effects. The bastion polls this during `waitForHealthy` (with a configurable timeout and poll interval).

### BOS `BOS_DATA_ROOT` (`src/os/vfs.ts` et al.)

All hardcoded `path.join(process.cwd(), 'data', ...)` roots in BOS are replaced with `path.join(process.env.BOS_DATA_ROOT ?? path.join(process.cwd(), 'data'), ...)`. Only the path roots change; no functional behaviour changes for existing single-user deployments (env var absent → same default path).

### BOS Dockerfile

Multi-stage:
1. **deps** stage: `npm ci` to populate `node_modules`.
2. **runtime** stage: copy source; no `npm run build` (BOS runs in dev mode per assumptions). Entrypoint: check `node_modules/.bin` populated (FR-009); if not, run `npm install`; then exec the Supervisor (`node tools/supervisor/supervisor.mjs` or equivalent) on `:8090`.

### Docker Compose topology

```
docker-compose.yml:
  bastion (./bastion/Dockerfile)
    ports: 80:3000
    volumes: /var/run/docker.sock, ./bastion/data:/data, ${VOLUME_BASE}:/user-data
    networks: [bos-net]
  (no BOS services — spawned at runtime)
  networks: bos-net (bridge)

docker-compose.keycloak.yml (override):
  keycloak (quay.io/keycloak/keycloak)
    volumes: ./bastion/keycloak/realm-export.json (pre-seeded realm)
    networks: [bos-net]
```

The bastion reaches spawned containers via Docker's internal DNS (`bos-{username}:8090`) on `bos-net`. No host port exposure for BOS containers.

### Admin UI + Account UI (Vite SPA)

Single Vite + React app with three pages:
- **`/login`**: username/password form (Simple) or "Sign in with Keycloak" button. Server-rendered placeholder served before JS hydrates.
- **`/admin`**: requires `isAdmin` session claim. Tabs: Users (table + CRUD modal), Instances (live status table, force-stop, re-provision), Settings (global config form), Auth (provider toggle + OIDC config fields).
- **`/account`**: any authenticated user. Shows instance status badge, last-active, uptime. Re-provision panel: five operations as labelled cards with a confirmation dialog for destructive ones.

The SPA is pre-built by `vite build` in the bastion's Dockerfile and served as static files from Express under `/app`. In `docker-compose.dev.yml` the Vite dev server runs on `:5173` and Express proxies `/app/**` to it.

## Out of scope (v1)

- Rootless Docker or Docker socket proxy hardening.
- Generic OIDC (non-Keycloak) providers.
- Per-user resource limits (CPU/memory cgroup constraints on spawned containers).
- Rolling BOS image upgrade (admin-triggered) — admin can force-restart instances; they'll pick up the new image if it has been re-pulled.
- Authorization beyond admin/user (group-based access control to BOS features).
- Automated backups of user volumes.
- BOS production build mode per instance (`npm run build`); instances run `npm run dev`.
- Multi-host / Swarm / Kubernetes deployment.
