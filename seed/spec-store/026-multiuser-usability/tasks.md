# Tasks: 026 Multi-User Usability

Feature branch: `026-multiuser-usability`. Tasks are grouped by phase; `[P]` marks work that can proceed in parallel with siblings.

## Phase A — Bastion foundations (logging + first-run) — P1

- [ ] A1. Add a persistent per-user log store to the Bastion (`bastion/src/log-store.ts`): append-only `{dataDir}/logs/<username>.log`, with `append`, `read(tail?)`, and `list` operations. Node built-ins only.
- [ ] A2. Wire `lifecycle.ts` `log()`/`updateState()` and `provision.ts` steps to also append to the per-user log (progress + errors with stack).
- [ ] A3. Extend `getInstanceState`/admin+account state responses with `error` reason and add endpoints to fetch the per-user log (`GET /admin/instances/:user/log`, `GET /account/log`).
- [ ] A4. First-run bootstrap (simple auth): detect "no admin" in `SimpleProvider`; add `GET /setup` state + `POST /setup` (create admin from `ADMIN_USER`, race-safe) in a new setup router; route unauthenticated entry to the setup SPA page when bootstrap is pending.
- [ ] A5. First-run landing (Keycloak): setup/landing page explaining IdP ownership + OIDC login link.
- [ ] A6. Bastion `typecheck` green.

## Phase B — Bastion admin portal — P1

- [ ] B1. Introduce Tailwind (or a small shared component set) into `bastion/ui`; establish layout/theme + shared primitives (Button, Card, Table, Dialog, Toast, LogView).
- [ ] B2. Rebuild `Login` + add `Setup` pages with the new UI.
- [ ] B3. Users view: create/remove/toggle-admin; remove flows through confirm → stop/remove container → wipe `user-data/<user>` (admin API `DELETE /admin/users/:user` with `wipeData` default true here) → **also** delete `{dataDir}/logs/<username>.log` and `{dataDir}/avatars/<username>`. In Keycloak mode, hide the Users tab and replace it with a message linking to the Keycloak console.
- [ ] B4. Images view: `dockerode` build with streamed log (SSE or chunked) — new `POST /admin/image/build` (stream) + `GET /admin/images`; set-active-tag writes `bosImage` via `saveConfig`. Includes **both** server-side streaming (chunked/SSE response from `dockerode.buildImage`) and the client-side `Images.tsx` log consumption (read the stream incrementally and append lines to a `LogView` component).
- [ ] B5. Containers view: list all (`listBosContainers` + state), Start/Stop/Kill actions (add `POST /admin/instances/:user/kill`).
- [ ] B6. Per-user log viewer wired to A3.
- [ ] B7. Bastion `typecheck` green.

## Phase C — Bastion account page — P1

- [ ] C1. Account page redesign with the Phase B UI.
- [ ] C2. Password set/change (simple auth only; hidden for Keycloak) — reuse `POST /account/password`.
- [ ] C3. Profile image: `POST /account/avatar` (validated upload) storing `{dataDir}/avatars/<username>`, `GET /avatar/:username` served by Bastion, bundled default fallback.
- [ ] C4. Lifecycle: Start/Stop/Restart + Re-provision + "Open my BrowserOS" (proxy to `/`).
- [ ] C5. Wipe data behind a strongly-worded confirm dialog (stop → wipe `data/` → offer restart).
- [ ] C6. Bastion `typecheck` green.

## Phase D — BOS run_command backend selection — P1/P2

- [ ] D1. `loadRcConfig()` / `registry.ts`: detect Bastion mode (`BOS_PUBLIC_PORT`) → force `backend: local`; hide docker-only fields.
- [ ] D2a. [P1] Custom Command Execution settings component — **Bastion local view**: when `BOS_PUBLIC_PORT` is set, render a read-only panel confirming `local` backend with no image picker or build affordance.
- [ ] D2b. [P2] Custom Command Execution settings component — **standalone image picker + build**: in non-Bastion mode, list local Docker images (`GET /api/run-command/images`) and offer build-from-Dockerfile (default `docker/run-command/Dockerfile`) with a streamed build log.
- [ ] D3. BOS API routes (server-only): `GET /api/run-command/images` (list) and `POST /api/run-command/image/build` (streamed build), guarded (single build, docker-availability check).
- [ ] D4. Typecheck + lint green.

## Phase E — BOS dev-harness credentials — P2

- [x] E1. Credential material for Claude/OpenCode is managed via a dedicated write-only route (`GET/POST /api/dev-harness/credentials`) + helpers in `harness-config.ts` (`hasClaudeCreds`/`hasOpenCodeAuth`/`writeClaudeCreds`/`writeOpenCodeAuth`/`clear*`). Kept out of the generic config namespace so raw secrets are never stored there or returned to the client — only a set/unset indicator.
- [x] E2. Credentials are written into a dedicated harness `HOME` (`{dataDir}/dev-harness/home/.claude/.credentials.json`, `.../.local/share/opencode/auth.json`) with dir `0o700` and files `0o600`; `harnessCredentialEnv()` sets `HOME`/`XDG_*` and is merged into `envForCwd()` in `claude-runner.ts` — only when credentials exist, so local dev with a real `~/.claude` is unaffected.
- [x] E3. DevHarnessTab UI: write-only credential textareas with SET/NOT SET indicators, Save + Clear per CLI, shown for CLI/OpenCode modes with container guidance.
- [x] E4. Typecheck + lint green.

## Phase F — BOS toolbar My profile — P2

- [ ] F1. `Topbar.tsx`: add a "My profile" control (multi-user only) linking to `/app/account`, showing the avatar (`/avatar/<me>`). The component must fetch `/api/system/session` at mount to obtain the current username (for the avatar URL) and to confirm multi-user context at the client level — do not hard-code or pass the username as a prop from SSR alone.
- [ ] F2. Typecheck + lint green.

## Cross-cutting

- [ ] X1. Update the user-container `Dockerfile` (root) to bundle run_command runtimes + Claude/OpenCode CLIs (FR-024). Use a multi-stage build; run `apt-get clean && rm -rf /var/lib/apt/lists/*` in every apt `RUN` block. Record the final compressed image size in a comment in the Dockerfile; if it exceeds 3 GB, document a slim-variant path.
- [ ] X2. E2E/manual verification per Success Criteria SC-001…SC-008.
- [ ] X3. Regression verification: confirm that existing `024` flows are unbroken — a pre-existing user can log in, their container provisions correctly, and the session proxy works — before closing the feature.

## Closeout (after implementation)

- [ ] Z1. Merge 026 into `024-docker-multiuser` (admin portal, account UX, first-run, per-user logging, image build, container kill) and `019-tools-and-sandbox` (local backend in Bastion; image convergence); note changes in `discrepancies.md`; add 026 row to `overview.md`.
- [ ] Z2. Update documentation (`docs/dev/**`, `docs/usage/**`).
- [ ] Z3. Final typecheck gate: run `tsc --noEmit` in `bastion/` **and** `npm run typecheck` in the BOS root; both must pass clean before the branch is considered ship-ready.
