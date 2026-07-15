# Feature Specification: Multi-User Usability (First-run, Admin Portal, Account UX, Container-native run_command & Harness Auth)

**Feature Branch**: `026-multiuser-usability`

**Created**: 2026-07-14

**Status**: Draft

**Input**: "Address usability challenges for normal users running BOS via docker compose. (1) The run-command image must be buildable from the UI (select an existing image or a Dockerfile) instead of manually. (2) Claude Code / OpenCode must be usable inside a container — the user needs a way to authenticate them. (3) When BOS runs behind the Bastion, a 'My profile' link in the toolbar must navigate to the user's account page. (4) The Bastion first-time deployment, admin portal, and account page must be dramatically improved: guided first-run, working+observable provisioning, user management with data wipe, image build, container control, a good-looking UI, password/profile-image management, and self-service lifecycle."

> This feature is a **usability layer** on top of `024-docker-multiuser` (the Bastion) and `019-tools-and-sandbox` (sandboxed `run_command`). It does not change BOS's identity; it removes the manual, error-prone, and undocumented steps that make a first-time docker-compose deployment fail silently, and it makes the Bastion's admin/account surfaces first-class. The BOS source changes are limited to run_command backend selection, dev-harness credential injection, and one toolbar link. The bulk of the work lives in the `bastion/` sub-project.

## Why this exists (context)

A "normal" operator who runs `docker compose up` today hits a wall:

- **run_command** needs a sandbox image that must be built by hand (`docker build -t browseros/run-command:latest docker/run-command`). There is no UI affordance and no guidance.
- **Claude Code / OpenCode** cannot be logged in inside a container (no interactive TTY, no persisted `~/.claude` / OpenCode `auth.json`), so the developer harness is dead on arrival in a container deployment.
- **Bastion first-run** requires hand-authoring `users.yml` with bcrypt hashes; there is no bootstrap. First provisioning of a user container "very often" fails, and there is **no logging anywhere** to explain why or how to fix it.
- The **admin UI** and **account page** are minimal, inline-styled, and missing key operations (data wipe, container start/stop/kill, image build, password/profile-image management).

This spec closes those gaps.

## Clarifications

### Session 2026-07-14

- Q: How should docker image builds behave in the UI? → A: **Streamed synchronous build** — kick off the build and stream the `docker build` log live into the UI with a final success/fail state (mirrors the Supervisor build panel).
- Q: How should Claude Code / OpenCode credentials be provided in a container? → A: **Mount credential files.** The user provides the CLIs' own auth material (Claude `~/.claude`, OpenCode `auth.json`); BOS writes them into a dedicated harness `HOME` before spawning. This supports OAuth/subscription logins, not just API keys.
- Q: How is the Bastion admin identity established on first run, and does it apply to Keycloak? → A: **Both auth modes get a first-run experience.** Simple auth: a "set admin password" page bootstraps the admin account. Keycloak: a setup/landing page (users/roles remain owned by the IdP; no password bootstrap).
- Q: Where are profile images stored? → A: **In the Bastion data dir** (`{dataDir}/avatars/<username>`), served by the Bastion; a system default is used when unset.
- Q: The run_command Docker backend needs the Docker socket, which user containers do not have. How do users run `run_command` in Bastion mode? → A: **Local backend inside the user's own container.** The admin-built **user-container image IS the run_command environment**, so it must bundle the run_command runtimes (python/node/LibreOffice/…) and the Claude/OpenCode CLIs. Building images is an **admin-only** operation in the Bastion admin portal; users do not build/select images in Bastion mode.
- Q: Does the "select an existing image / build from a Dockerfile" run_command UI still exist? → A: **Standalone (non-Bastion) mode only.** In Bastion mode BOS forces the `local` backend and hides image selection/build.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Guided first-run for a fresh Bastion deployment (Priority: P1)

An operator runs `docker compose up` for the first time and browses to the Bastion. Instead of a login form they cannot use (no users exist), they are guided to set the admin password (simple auth) or to a setup/landing page (Keycloak). After setting the password they are logged in as admin and land on the admin portal.

**Why this priority**: This is the first thing every new operator hits; if it fails, nothing else is reachable.

**Independent Test**: Bring up a fresh stack with an empty data dir and `AUTH_PROVIDER=simple`; visit the Bastion; confirm the set-admin-password page appears, submit a password, and confirm you are authenticated and redirected to `/app/admin`.

**Acceptance Scenarios**:

1. **Given** a fresh simple-auth deployment with no admin user, **When** the operator visits any Bastion page, **Then** they are routed to a "Set admin password" page (not the normal login).
2. **Given** the set-admin-password page, **When** a valid password is submitted, **Then** an admin user is created, a session is issued, and the browser is redirected to the admin portal.
3. **Given** an admin already exists, **When** anyone visits the Bastion, **Then** the bootstrap page is NOT shown and normal login applies.
4. **Given** `AUTH_PROVIDER=keycloak`, **When** the operator first visits the Bastion, **Then** a setup/landing page explains that users are managed in Keycloak and links to the OIDC login (no password bootstrap).

### User Story 2 — Provisioning is observable; failures are diagnosable (Priority: P1)

When a user's container fails to provision, the failure is captured to a persistent per-user log with a human-readable reason and is visible in the admin portal (and to the user on their account page). No failure is silent.

**Why this priority**: "First-time provisioning very often fails and there is no logging" is called out as a top pain point.

**Independent Test**: Force a provisioning failure (e.g. a bad `bosImage`); confirm the admin portal shows the instance as failed with a reason and a viewable log, and the user's account page shows the same.

**Acceptance Scenarios**:

1. **Given** a provisioning attempt, **When** any step logs progress or an error, **Then** it is appended to a persistent per-user log under the Bastion data dir.
2. **Given** a failed provision, **When** the admin opens the instance, **Then** the status is `failed`/`unknown` with the captured reason and a full log viewer.
3. **Given** a failed provision, **When** the user opens their account page, **Then** they see the failure reason and a retry (re-provision) affordance.

### User Story 3 — Admin manages users, with data wipe on removal (Priority: P1)

An admin creates and removes users from the portal. Removing a user also wipes their data directory (`user-data/<user>`), with an explicit confirmation.

**Independent Test**: Create user `bob`; confirm `bob` can log in and provision; delete `bob` with the wipe confirmation; confirm the auth record is gone and `user-data/bob` no longer exists.

**Acceptance Scenarios**:

1. **Given** the admin users page, **When** the admin creates a user, **Then** the user can immediately log in.
2. **Given** an existing user, **When** the admin removes them and confirms, **Then** the auth record is deleted AND `user-data/<user>` (src, data, node_modules volume) is wiped.
3. **Given** the last admin, **When** the admin tries to remove their own admin flag or delete themselves, **Then** it is blocked.

### User Story 4 — Admin builds the user-container image from the portal (Priority: P1)

An admin configures and builds the image used for user containers (which is also the `run_command` environment) directly from the admin portal, watching the build log stream, without touching a shell.

**Independent Test**: On the admin image page, choose the repo `Dockerfile`, set the tag, click Build, watch the streamed log, and on success confirm new user containers use the freshly built image.

**Acceptance Scenarios**:

1. **Given** the image page, **When** the admin selects a Dockerfile/context and a tag and clicks Build, **Then** the `docker build` output streams live and ends in a clear success/fail state.
2. **Given** a successful build, **When** the tag is set as the active `bosImage`, **Then** newly provisioned/restarted containers use it.
3. **Given** a build failure, **When** it ends, **Then** the full error is visible in the streamed log and the active image is unchanged.

### User Story 5 — Admin sees and controls all running containers (Priority: P1)

The admin views all user containers with live status and can start, stop, or kill (force-remove) any of them.

**Acceptance Scenarios**:

1. **Given** the containers page, **When** it loads, **Then** every user container is listed with its live status and last-active time.
2. **Given** a running container, **When** the admin clicks Stop, **Then** it stops gracefully; **When** the admin clicks Kill, **Then** it is force-removed.
3. **Given** a stopped container, **When** the admin clicks Start, **Then** it starts and becomes healthy.

### User Story 6 — Self-service account page (Priority: P1)

A user manages their own instance from a good-looking account page: set/change password, set a profile image (default fallback), start/stop/restart the container, wipe their data (with a strongly-worded confirmation), re-provision, and open their BrowserOS.

**Acceptance Scenarios**:

1. **Given** the account page (simple auth), **When** the user sets a new password, **Then** subsequent logins require it. (Keycloak: password controls are hidden.)
2. **Given** no profile image set, **When** the page renders, **Then** a system default avatar is shown; **When** the user uploads one, **Then** it is stored in the Bastion data dir and shown thereafter.
3. **Given** the lifecycle controls, **When** the user clicks Start/Stop/Restart, **Then** their container transitions accordingly.
4. **Given** the "Wipe my data" control, **When** clicked, **Then** a confirmation dialog warns that VFS content and conversations will be permanently destroyed; only on explicit confirm is `data/` wiped.
5. **Given** a running instance, **When** the user clicks "Open my BrowserOS", **Then** they are routed into their BOS session.

### User Story 7 — "My profile" link in the BOS toolbar (Priority: P2)

When BOS runs behind the Bastion (multi-user mode), the desktop toolbar shows a "My profile" affordance that navigates to the Bastion account page.

**Acceptance Scenarios**:

1. **Given** BOS launched by the Bastion (`BOS_PUBLIC_PORT` set), **When** the desktop renders, **Then** a "My profile" control (with the user's avatar) is shown that links to `/app/account`.
2. **Given** BOS running standalone (no Bastion), **When** the desktop renders, **Then** no "My profile" control is shown.

### User Story 8 — run_command works out of the box inside a user container (Priority: P1)

In Bastion mode, `run_command` uses the `local` backend inside the user's own container, whose image (admin-built) already bundles the required runtimes. The user does not select or build an image.

**Acceptance Scenarios**:

1. **Given** BOS in Bastion mode with `run_command` enabled, **When** the agent runs a command, **Then** it executes with the `local` backend inside the container and outputs appear in the Files app.
2. **Given** BOS in Bastion mode, **When** the user opens Command Execution settings, **Then** image build/selection is hidden and the backend is fixed to `local`.

### User Story 9 — Standalone image select/build for run_command (Priority: P2)

In standalone (non-Bastion) mode, the Command Execution settings let the user pick an existing local image OR build one from a Dockerfile (default `docker/run-command/Dockerfile`), with a streamed build log.

**Acceptance Scenarios**:

1. **Given** standalone mode, **When** the user opens Command Execution settings, **Then** they can choose from local images or provide a Dockerfile/context + tag and build (streamed log).
2. **Given** a successful build, **When** it completes, **Then** the built tag is selectable and used by the Docker backend.

### User Story 10 — Configure Claude Code / OpenCode credentials for a container (Priority: P2)

The dev-harness settings let the user provide the Claude Code and OpenCode credential material; BOS writes it into a dedicated harness `HOME` so the headless CLIs authenticate without an interactive login.

**Acceptance Scenarios**:

1. **Given** the Dev Harness settings, **When** the user provides Claude credential material and saves, **Then** a subsequent `claude -p` run authenticates using it (no interactive login).
2. **Given** OpenCode credential material provided, **When** an `opencode run` executes, **Then** it authenticates using the written `auth.json`.
3. **Given** the "Test" action, **When** run, **Then** it reports whether the configured CLI is reachable/authenticated.

### Edge Cases

- Bootstrap race: two operators open the set-admin-password page at once — only one admin is created; the second submission is rejected with a clear message.
- Deleting a user whose container is running: the container is stopped/removed before the data dir is wiped.
- Wiping data while the container is running: the container is stopped first, `data/` wiped, then restart is offered.
- Building an image while a build is already running: a second build is rejected (or queued) with a clear message; logs never interleave.
- Profile image upload of an invalid/oversized file: rejected with a clear error; existing avatar unchanged.
- Credential material is secret: it MUST be stored with the same protection as other config secrets and MUST NOT be echoed back to the client after save (write-only field with a "set/!set" indicator).
- Standalone build when the Docker daemon/CLI is unavailable: the UI reports it clearly and the free-text/local path still works.

## Requirements *(mandatory)*

### Functional Requirements

#### Bastion — first-run bootstrap

- **FR-001**: When `AUTH_PROVIDER=simple` and no admin user exists, the Bastion MUST route all UI entry points to a **Set admin password** flow instead of normal login. Submitting a valid password MUST create the admin user (username from `ADMIN_USER`, default `admin`), issue a session, and redirect to the admin portal. Once any admin exists, the bootstrap flow MUST NOT be shown.
- **FR-002**: When `AUTH_PROVIDER=keycloak`, first visit MUST present a **setup/landing** page that explains user/role ownership by the IdP and links to the OIDC login; no password bootstrap is performed.
- **FR-003**: The bootstrap endpoint MUST be idempotent and race-safe — concurrent bootstrap submissions MUST create at most one admin.

#### Bastion — provisioning observability & logging

- **FR-004**: The Bastion MUST persist a per-user provisioning/lifecycle log (append-only) under its data dir (e.g. `{dataDir}/logs/<username>.log`). Every provisioning/lifecycle step and every failure (with reason/stack) MUST be recorded.
- **FR-005**: Instance state exposed by admin and account endpoints MUST include `status`, `lastActive`, a short `error` reason when failed, and MUST allow retrieval of the full per-user log.
- **FR-006**: On provisioning failure, the user-facing status page and the account page MUST show the reason and a retry (re-provision) affordance rather than a raw proxy error.

#### Bastion — admin portal

- **FR-007**: The admin portal MUST provide a **Users** view: list users; create user; remove user; toggle admin (last-admin protected). Removing a user MUST stop/remove a running container first, then, after an explicit confirmation, wipe `user-data/<user>` (src + data + node_modules volume) **and** the per-user log (`{dataDir}/logs/<username>.log`) and avatar (`{dataDir}/avatars/<username>`) from the Bastion data dir.
- **FR-008**: The admin portal MUST provide an **Images** view to configure and **build** the user-container image via the Docker SDK (`dockerode`, per `024` FR-003 — no shelling out to the docker CLI). The build MUST stream its log to the client in real time and end in an explicit success/fail state. On success the admin MAY set the built tag as the active `bosImage`.
- **FR-009**: The admin portal MUST provide a **Containers** view listing all user containers with live status and last-active time, with **Start**, **Stop** (graceful), and **Kill** (force-remove) actions.
- **FR-010**: The admin portal MUST also surface the per-user provisioning log (FR-004) for diagnosis.
- **FR-011**: The admin portal UI MUST be a cohesive, good-looking SPA (Tailwind-based component set), replacing the current inline-styled pages.

#### Bastion — account page

- **FR-012**: The account page MUST let a user **set/change their password** (simple auth only; hidden for Keycloak).
- **FR-013**: The account page MUST let a user **set a profile image**; images are stored under the Bastion data dir (`{dataDir}/avatars/<username>`) and served by the Bastion. A bundled **system default avatar** MUST be used when none is set. Uploads MUST be validated (type + size).
- **FR-014**: The account page MUST expose instance **Start / Stop / Restart**, **Re-provision**, and **Open my BrowserOS**.
- **FR-015**: The account page MUST expose **Wipe my data** behind a confirmation dialog whose text clearly warns that VFS content and conversations are permanently destroyed. Wipe MUST stop the container first, wipe the user's BOS `data/` directory (inside `user-data/<user>`), and offer restart. The Bastion-managed avatar and provisioning log are **not** wiped here — they are PII that persists for admin diagnosis and is only wiped when the user is fully deleted (FR-007).
- **FR-016**: The account page UI MUST match the redesigned admin portal's look and feel.

#### BOS — run_command backend selection

- **FR-017**: BOS MUST detect Bastion (multi-user) mode via `process.env.BOS_PUBLIC_PORT` (server-only code). In Bastion mode, `run_command` MUST use the **`local`** backend inside the user's own container; the Command Execution settings MUST hide image build/selection and MUST NOT offer the Docker backend.
- **FR-018**: In **standalone** mode, the Command Execution settings MUST let the user (a) select an existing local Docker image, or (b) build one from a Dockerfile (default `docker/run-command/Dockerfile`) + build context, with a **streamed** build log. The selected/built tag becomes `run-command.dockerImage`.
- **FR-019**: Image listing and building for standalone mode MUST be exposed via BOS API routes (server-only) that use the Docker SDK/CLI already assumed by `019`; builds MUST stream output and be guarded (single concurrent build, clear errors when Docker is unavailable).

#### BOS — dev-harness credentials

- **FR-020**: The `dev-harness` config MUST accept credential material for **Claude Code** (its `~/.claude` credentials/config) and **OpenCode** (`auth.json`). BOS MUST write this material into a dedicated harness `HOME` directory and set `HOME` (and any required env) when spawning `claude`/`opencode`, so the headless CLIs authenticate without interactive login.
- **FR-021**: Credential fields MUST be treated as secrets: stored with the config store's protection, never returned to the client after save (write-only with a set/unset indicator), and never logged.
- **FR-022**: The Dev Harness settings UI MUST let the user enter/update the credential material and MUST provide guidance for a container deployment; the existing "Test" action MUST report reachability/auth status.

#### BOS — toolbar

- **FR-023**: In multi-user mode, the desktop toolbar MUST show a **My profile** control linking to `/app/account`, ideally showing the user's avatar. In standalone mode it MUST NOT be shown. Detection uses both mechanisms: `process.env.BOS_PUBLIC_PORT` in server-only code (e.g. to gate SSR props), and the `/api/system/session` endpoint in client components (to obtain the current username and confirm multi-user context at runtime).

#### Image contents

- **FR-024**: The user-container image (the one the admin builds and also the `run_command` `local` environment) MUST bundle the runtimes `run_command` skills require (python/node/LibreOffice/poppler/etc., mirroring `docker/run-command/Dockerfile`) and the **Claude Code** and **OpenCode** CLIs, so both `run_command` (local) and the dev harness work inside a user container out of the box.

### Key Entities

- **Bootstrap state** — derived: "no admin exists" (simple auth) gates the set-admin-password flow.
- **Per-user log** — append-only text under `{dataDir}/logs/<username>.log`; the single source of truth for provisioning diagnosis.
- **Image build job** — a streamed `dockerode` build (context + Dockerfile + tag); at most one concurrent per surface.
- **Profile image** — a file under `{dataDir}/avatars/<username>`; a bundled default when absent.
- **Harness credential set** — Claude (`~/.claude` material) + OpenCode (`auth.json`) written into a dedicated `HOME`; secret, write-only in the API.
- **run_command mode** — `local` (Bastion, inside the user container) vs `docker`/`local` selectable (standalone).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh `docker compose up` (simple auth, empty data dir) lets an operator set the admin password in the browser and reach the admin portal with **zero** manual `users.yml` editing or shell commands.
- **SC-002**: A deliberately-broken provisioning attempt is visible as `failed` with a human-readable reason and a full log in both the admin portal and the user's account page — no silent failure.
- **SC-003**: An admin creates a user, that user logs in and gets a working instance, and later the admin removes the user and their `user-data/<user>` is gone — all from the portal.
- **SC-004**: An admin builds the user-container image from the portal, watching the streamed log, and new containers use it — no shell.
- **SC-005**: In Bastion mode, `run_command` executes inside the user container (local backend) and writes a file visible in the Files app, with no image selection shown.
- **SC-006**: With Claude/OpenCode credentials configured, a headless harness run authenticates and completes inside a container without any interactive login.
- **SC-007**: Behind the Bastion, the BOS toolbar shows a working "My profile" link to the account page; standalone shows none.
- **SC-008**: `npx tsc --noEmit` / `npm run typecheck` and lint pass in both `bastion/` and BOS for all changed files.

## Assumptions & Dependencies

- Builds on `024-docker-multiuser` (Bastion: auth providers, lifecycle, volume layout, docker-compose) and `019-tools-and-sandbox` (`run_command`, sandbox image). Interacts with `005-self-modification` (dev harness / Supervisor) and `017-central-logging` (BOS-side logging conventions; the Bastion keeps its own file log since it is a separate process).
- The Docker socket mount into the Bastion is already in the threat model (`024`). This feature does **not** mount the Docker socket into user containers (that was rejected in favor of the `local` backend).
- Username charset `[a-z0-9_-]` continues to bound container/volume/path names.
- Keycloak remains the only OIDC provider in scope; the Keycloak first-run is informational only.
- Storing harness credentials at rest is acceptable for self-hosted/trusted-operator installs, consistent with `024`'s threat model; they are treated as secrets in transit and in the API.

## Notes

- This spec supersedes parts of `024-docker-multiuser` FR-016 (admin page) and its self-service scenario (US5) by expanding them; on completion, `024` MUST be updated (and `discrepancies.md` noted) to reference the redesigned portal/account, the first-run bootstrap, per-user logging, image build, and container kill.
- It refines `019-tools-and-sandbox` FR-006/FR-007: in Bastion mode the backend is fixed to `local`; the sandbox image and the user-container image converge (FR-024). `019` MUST be updated accordingly on completion.
- Dev docs and usage docs (`docs/dev/**`, `docs/usage/**`) MUST be updated as the final step.
