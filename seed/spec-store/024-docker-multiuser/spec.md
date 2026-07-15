# Feature Specification: Docker Multi-User Deployment (Bastion + Dynamic Instances)

**Feature Branch**: `024-docker-multiuser`

**Created**: 2026-07-07

**Status**: Draft

**Input**: "Make BOS deployable as a Docker Compose stack with multi-user support and authentication. A bastion container handles auth and routes each authenticated user to their own dynamically-spawned BOS instance. Each user gets an isolated source tree (so they can mutate their own BOS), their own data volume, and their own node_modules volume. Auth supports a simple file-based provider (dev/local) and Keycloak OIDC. The bastion exposes an admin page (admin-only) for global settings and user management, and a self-service page (all users) for instance management and re-provisioning."

> This feature makes BOS a deployable multi-tenant service. Each user gets a full, independently-mutable BOS instance — consistent with BOS's "OS that edits itself" identity (005-self-modification) — while the bastion acts as the single ingress point owning auth, routing, and container lifecycle. The BOS source itself is unchanged; the bastion is a new sibling sub-project (`bastion/`).

## Why this exists (context)

BOS today runs as a single-user `npm run dev` process. There is no auth, no isolation between users, and no path to deploying it for a team or as a hosted service. Docker Compose is the natural packaging for a service with multiple cooperating processes; multi-user requires that each user's BOS instance be fully isolated (source, data, dependencies) so that one user's mutations do not affect another's.

The bastion pattern (auth-aware reverse proxy that also manages container lifecycle) is chosen over a static Compose file with hardcoded user services because: (a) users are not known at build time, (b) dynamic spawning avoids running idle instances for all registered users, and (c) it gives a natural home for the admin and self-service UIs without adding surface area to BOS itself.

Routing to port **8090** (the Supervisor) rather than 3000 (Next.js directly) is intentional: the Supervisor is already the lifecycle-owning entry point for a BOS instance and the correct single ingress for proxied traffic.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A new user logs in and gets their own BOS instance (Priority: P1)

A user visits the bastion URL, authenticates (Simple or Keycloak), and is transparently proxied to a freshly-provisioned BOS instance scoped to them. On first login the instance is created; on subsequent logins it resumes or is restarted if it was stopped due to idle timeout.

**Why this priority**: This is the entire point of the feature — without it nothing else has value.

**Independent Test**: Register a new user, log in, confirm a BOS container is spawned with isolated src/data/node_modules volumes, and that the browser lands in a working BOS session.

**Acceptance Scenarios**:

1. **Given** a fresh install with no running instances, **When** user Alice logs in, **Then** a container `bos-alice` is created with Alice's volume mounts and she is proxied into her BOS.
2. **Given** Alice's instance was stopped by idle timeout, **When** Alice logs in again, **Then** her instance is restarted and she resumes with her previous data intact.
3. **Given** Alice and Bob both log in concurrently, **When** both sessions are active, **Then** each is proxied only to their own instance with no cross-contamination.

### User Story 2 — Simple file-based auth (Priority: P1)

An operator defines users in a YAML file (username, bcrypt-hashed password, groups). The bastion authenticates against this file with no external service required. Suitable for local installs and development.

**Why this priority**: Required for the feature to be usable without a Keycloak server — dev/local deployments are the first adopters.

**Independent Test**: Configure `users.yaml` with two users; log in as each; confirm auth accepts correct credentials and rejects wrong ones.

**Acceptance Scenarios**:

1. **Given** a `users.yaml` with user `alice` and a bcrypt hash, **When** Alice logs in with the correct password, **Then** she is authenticated and receives a session.
2. **Given** the same file, **When** Alice submits a wrong password, **Then** she receives a 401 and no session is created.
3. **Given** a `users.yaml` change (new user added), **When** the bastion reloads it (hot-reload or restart), **Then** the new user can log in without a container restart.

### User Story 3 — Keycloak OIDC auth (Priority: P1)

An operator configures Keycloak credentials in the bastion config. The login flow redirects to Keycloak, the bastion validates the `id_token` via JWKS, and derives the BOS username from `preferred_username` (or a configurable claim).

**Why this priority**: Required for production/enterprise deployments where password management is delegated to an IdP.

**Independent Test**: Deploy a Keycloak realm with a test user; configure the bastion to use it; log in via Keycloak; confirm a BOS instance is spawned under the correct username.

**Acceptance Scenarios**:

1. **Given** Keycloak configured, **When** a user visits the bastion, **Then** they are redirected to Keycloak's login page.
2. **Given** successful Keycloak authentication, **When** the bastion receives the callback, **Then** it validates the token via JWKS, extracts the username, and issues a bastion session.
3. **Given** an expired or invalid token, **When** it is presented to the bastion, **Then** the session is rejected and the user is redirected to login.

### User Story 4 — Admin page: global settings and user management (Priority: P2)

An admin-flagged user accesses `/admin` on the bastion and can manage users (create/delete/reset password/assign groups), view all running instances, change global settings (BOS image tag, volume base path, idle timeout, max concurrent instances), and configure the active auth provider.

**Why this priority**: Without admin tooling the operator must edit config files manually; important but the system still works without it at v1.

**Independent Test**: Log in as admin; create a new user from the admin page; confirm they can log in and get an instance; change idle timeout; confirm instances stop after the new timeout.

**Acceptance Scenarios**:

1. **Given** an admin session, **When** the admin accesses `/admin`, **Then** the admin page renders and a non-admin user accessing the same URL receives 403.
2. **Given** the admin page, **When** the admin creates a new user, **Then** the user appears in the auth store and can immediately log in.
3. **Given** the instance table, **When** the admin force-stops an instance, **Then** the container is stopped and the user's next request triggers a fresh start.
4. **Given** global settings, **When** idle timeout is changed, **Then** it takes effect for newly started instances without a bastion restart.

### User Story 5 — User self-service: instance management and re-provisioning (Priority: P2)

Any authenticated user accesses `/account` to view their instance status, restart it, and trigger targeted re-provisioning (with choices: keep data, wipe node_modules only, reset source, or full re-provision).

**Why this priority**: Users who mutate their BOS source will eventually break something; self-service recovery is essential so they do not need to contact an admin.

**Independent Test**: As a regular user, break the BOS instance (e.g. corrupt `src/`), navigate to `/account`, choose "Reset source (keep data)", confirm the source is re-cloned and the instance restarts while `data/` is preserved.

**Acceptance Scenarios**:

1. **Given** an authenticated user, **When** they visit `/account`, **Then** they see their instance status and re-provision options (and cannot see other users' instances).
2. **Given** a broken source tree, **When** the user chooses "Reset source, keep data", **Then** `src/` is re-cloned from the base ref and `data/` is untouched.
3. **Given** broken dependencies, **When** the user chooses "Reinstall dependencies", **Then** the node_modules volume is wiped and `npm install` runs on next container start.
4. **Given** the nuclear option "Full re-provision", **When** the user confirms, **Then** `src/`, `data/`, and the node_modules volume are all wiped and re-provisioned from scratch.

### User Story 6 — Idle instances stop automatically (Priority: P2)

BOS instances that have received no proxied request for a configurable idle timeout are automatically stopped. The user's volumes are preserved. The next request restarts the instance transparently.

**Why this priority**: Without idle management a multi-user deployment leaks memory and CPU proportional to the number of registered users, not active ones.

**Independent Test**: Set idle timeout to 60 seconds; log in as Alice; wait 70 seconds without activity; confirm `bos-alice` is stopped; make a request; confirm it restarts and the session resumes.

**Acceptance Scenarios**:

1. **Given** an idle timeout of N seconds, **When** an instance has received no request for N seconds, **Then** it is stopped.
2. **Given** a stopped instance, **When** a proxied request arrives for that user, **Then** the instance is restarted before the request is forwarded (with appropriate loading state).
3. **Given** an active session, **When** the user is actively using BOS, **Then** the idle timer is reset on each request and the instance is not stopped.

### Edge Cases

- A user's container fails to start (e.g. broken `npm install`): the bastion returns a user-visible error page with a link to `/account` for re-provisioning, not a raw proxy error.
- Docker socket becomes unavailable: the bastion logs the error and returns 503; existing proxied sessions are not affected until their instance needs restart.
- Two concurrent login requests for the same user (race on provisioning): only one container is created; the second request waits for and then reuses the running instance.
- Volume base path is not writable: bastion startup fails with a clear error message naming the path and required permissions.
- Admin demotes themselves: prevented — the last admin-flagged user cannot lose the admin flag.
- Max concurrent instances reached: new logins are queued or rejected with a configurable message; existing sessions continue.
- BOS image is updated (new tag): existing running instances continue on the old image until restarted; the admin can trigger a rolling restart from the admin page.

## Requirements *(mandatory)*

### Functional Requirements

#### Bastion sub-project

- **FR-001**: A new `bastion/` subdirectory at the repo root MUST contain the bastion as a self-contained sub-project with its own `package.json`, `Dockerfile`, and `src/`. It MUST NOT depend on `src/` (BOS source) at runtime. The bastion is built and shipped as a separate Docker image.
- **FR-002**: The bastion MUST be an HTTP server (Node.js/Express) that:
  - serves its own login UI, admin UI (`/admin/**`), and user self-service UI (`/account/**`) as a React SPA (Vite-built, served as static files from the same Express process),
  - reverse-proxies all other authenticated traffic to the user's BOS container on port **8090** (the Supervisor),
  - supports WebSocket proxying (CopilotKit streaming and BOS dev-server HMR both traverse this proxy).
- **FR-003**: The bastion MUST communicate with the Docker daemon via the Docker SDK (`dockerode`) mounted at `/var/run/docker.sock`. All container lifecycle operations (create, start, stop, inspect, remove) and volume operations (create, remove) go through this SDK; the bastion MUST NOT shell out to the `docker` CLI.
- **FR-004**: All spawned BOS containers MUST be created on a dedicated Docker bridge network (`bos-net`) so the bastion can reach them by container name DNS (`bos-{username}:8090`) without exposing their ports on the host.

#### Auth providers

- **FR-005**: The bastion MUST support two auth providers, selectable via an env var (`BASTION_AUTH_PROVIDER=simple|keycloak`):
  - **Simple**: reads a YAML file (`/data/users.yaml`) containing users with bcrypt-hashed passwords and group memberships. The file MUST be hot-reloaded (inotify or poll) so new users take effect without a bastion restart.
  - **Keycloak**: standard Authorization Code + PKCE flow; validates `id_token` via the Keycloak JWKS endpoint; derives the BOS username from a configurable claim (default: `preferred_username`).
- **FR-006**: Sessions MUST be managed via signed, HTTP-only cookies (JWT or opaque token backed by server-side state in a JSON file under `/data`). Session lifetime is configurable; the session carries `{ username, groups, isAdmin }`.
- **FR-007**: The admin role MUST be determined by group membership (`admin` group in Simple provider; a configurable claim/role in Keycloak). Admin-only routes (`/admin/**`) MUST return 403 for non-admin sessions.

#### Container lifecycle

- **FR-008**: On the first authenticated request for a user who has no existing instance, the bastion MUST:
  1. Create the host directories `{VOLUME_BASE}/{username}/src/` and `{VOLUME_BASE}/{username}/data/` if absent.
  2. Seed `{VOLUME_BASE}/{username}/src/` by `git clone`-ing the BOS base ref (configurable tag/branch) — this gives the user a proper git repo from day one, consistent with `005-self-modification`.
  3. Create a Docker named volume `bos-nm-{username}` (the user's `node_modules`).
  4. Create and start a container `bos-{username}` with mounts: `src/` → `/app/src`, `data/` → `/app/data`, `bos-nm-{username}` → `/app/node_modules`.
  5. Wait for the container's health check (Supervisor responding on `:8090`) before forwarding the request.
- **FR-009**: The BOS Docker image's entrypoint MUST check whether `/app/node_modules/.bin` is populated; if not (fresh named volume), it MUST run `npm install` before starting the Supervisor. This ensures first-start after provisioning (or after a node_modules wipe) installs dependencies automatically.
- **FR-010**: The bastion MUST track a last-active timestamp per instance and stop containers that have been idle longer than `IDLE_TIMEOUT` (configurable; default 30 minutes). Volumes are preserved. On the next request the instance is restarted.
- **FR-011**: Container names MUST follow the pattern `bos-{username}` and be idempotent — attempting to create a container that already exists (e.g. from a bastion restart) MUST detect and reuse the existing container rather than error.

#### Volume layout

- **FR-012**: The volume layout per user MUST be:
  ```
  {VOLUME_BASE}/{username}/src/    ← bind mount → /app/src   (user's mutable BOS source, git repo)
  {VOLUME_BASE}/{username}/data/   ← bind mount → /app/data  (runtime data: VFS, conversations, agent state)
  Docker named volume bos-nm-{username} → /app/node_modules  (user's npm dependencies)
  ```
  `VOLUME_BASE` MUST be configurable via env var (default `./user-data`).
- **FR-013**: The BOS application MUST be updated to respect a `BOS_DATA_ROOT` env var (default `./data`) so each spawned container can be pointed at its bind-mounted data directory rather than a hardcoded relative path. At minimum `src/os/vfs.ts` and any other hardcoded `data/` path roots MUST honour this var.

#### Re-provisioning

- **FR-014**: The bastion MUST expose the following re-provision operations on `/account/reprovision` (POST, authenticated, own instance only):

  | Operation | Wipes `src/` | Wipes `data/` | Wipes `node_modules` vol |
  |---|---|---|---|
  | `restart` | — | — | — |
  | `reinstall_deps` | — | — | yes → `npm install` on next start |
  | `reset_source` | yes → re-clone | — | yes |
  | `keep_data_full_reset` | yes → re-clone | — | yes |
  | `full_reprovision` | yes → re-clone | yes | yes |

  The operation MUST stop the container before modifying volumes and restart it after.
- **FR-015**: The admin page MUST expose the same re-provision operations for any user's instance (admin-scoped endpoint `/admin/reprovision`).

#### Admin page

- **FR-016**: The admin page (`/admin`) MUST provide:
  - **User management**: list users; create user (Simple provider: username + password + groups); delete user (with a choice to also wipe their volumes); reset password; toggle admin flag (blocked if last admin).
  - **Instance table**: list all containers with name, status (running/stopped), last-active timestamp; force-stop; force re-provision per user.
  - **Global settings** (persisted to `/data/config.json`): `BOS_IMAGE` (image tag to use for new instances), `VOLUME_BASE`, `IDLE_TIMEOUT`, `MAX_CONCURRENT_INSTANCES`, `BOS_BASE_REF` (git ref for `src/` clone).
  - **Auth config**: active provider; for Keycloak — OIDC issuer URL, client ID/secret, username claim.

#### Docker Compose

- **FR-017**: A `docker-compose.yml` at the repo root MUST define:
  - `bastion` service: built from `./bastion/Dockerfile`, port `80:3000` (or configurable), mounts `/var/run/docker.sock`, `./bastion/data:/data`, `${VOLUME_BASE}:/user-data`.
  - `bos-net` bridge network (external: false — owned by Compose).
  - No BOS instance services — those are spawned at runtime.
  - A `docker-compose.dev.yml` override that mounts `./bastion/src` into the bastion container for hot-reload during bastion development.
- **FR-018**: A `docker-compose.keycloak.yml` override MUST provide a Keycloak service (official image, pre-seeded realm config) for operators who want OIDC without an external IdP.

### Key Entities

- **Bastion** — the single-ingress Node.js/Express container; owns auth, session, routing, Docker lifecycle, admin UI, self-service UI.
- **BOS instance** — a dynamically-spawned Docker container running the BOS Supervisor on `:8090`; one per user; named `bos-{username}`.
- **User record** — `{ username, passwordHash?, groups, isAdmin }` in `users.yaml` (Simple) or derived from OIDC claims (Keycloak).
- **Session** — a signed HTTP-only cookie issued by the bastion after successful authentication; carries identity and admin flag.
- **Volume triple** — the three isolated mounts per user: `src/` bind mount, `data/` bind mount, `bos-nm-{username}` named volume.
- **Instance state** — bastion-maintained in-memory + `/data/instances.json`: `{ username, containerId, status, lastActive }`.
- **Global config** — persisted to `/data/config.json`; controls image tag, volume base, idle timeout, max instances, base ref.
- **Auth provider** — a pluggable module (`simple` or `keycloak`) behind a common interface: `authenticate(req) → UserRecord | null`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh `docker compose up` with two configured users results in no BOS containers running; logging in as each user creates their container and serves a working BOS session concurrently, with zero shared state between them.
- **SC-002**: After `IDLE_TIMEOUT` seconds of inactivity, a BOS container is stopped; the next request restarts it in under 30 seconds and the user's VFS content is intact.
- **SC-003**: A user who corrupts their `src/` can recover via "Reset source, keep data" from `/account` and be back in a working BOS session within 3 minutes, with their `data/` untouched.
- **SC-004**: Switching `BASTION_AUTH_PROVIDER` from `simple` to `keycloak` (with the compose override) requires no code change — only config.
- **SC-005**: The admin page can create a new user and that user can log in and receive a provisioned instance within one minute, with zero manual Docker commands.
- **SC-006**: `npx tsc --noEmit` and `npm run lint` pass in `bastion/` with zero errors.

## Assumptions

- BOS is run in development mode (`npm run dev`) inside each user's container; production build mode is out of scope for v1 (no `npm run build` per instance).
- `VOLUME_BASE` is on the Docker host filesystem; the bastion has write access to it.
- The Docker socket mount (`/var/run/docker.sock`) is acceptable in the threat model for this deployment — self-hosted or trusted-operator installs. Rootless Docker or a Docker socket proxy can be layered on later.
- Username characters are restricted to `[a-z0-9_-]` (enforced at auth + provisioning) to ensure safe use in container names, volume names, and filesystem paths.
- Keycloak is the only OIDC provider in scope for v1; generic OIDC (any compliant IdP) is a natural extension but not required.
- Authorization (roles beyond admin/user, per-feature access control) is out of scope for v1; the spec models Simple groups and Keycloak roles only as an admin flag source.
- The bastion sub-project uses TypeScript; its build toolchain (`tsc`, `vite` for the SPA) is independent of BOS's `next` build.
- BOS instances do not communicate with each other; the bastion is the only inter-container communication path.
