# BrowserOS — Docker Multi-User Deployment

## Architecture

```
Browser ──► bastion:80 ──► bos-{username}:8090 (Supervisor)
```

The bastion handles authentication, per-user container lifecycle, and proxies all HTTP and WebSocket traffic to each user's BOS instance. Containers are spawned dynamically on first login and then run until explicitly stopped (there is no idle reaper).

Each user gets three isolated volumes:
- **`src/`** — a git clone of BOS source they can freely mutate
- **`data/`** — their runtime data (VFS, conversations, agent state)
- **`bos-nm-{username}`** — their own `node_modules` Docker volume

## Quick start

### 1. Build the BOS image
```bash
docker build -t browseros:latest .
```

Optional. If `BOS_IMAGE` doesn't exist when a user's container is first
created, the bastion builds it automatically from `BOS_REPO_PATH` — see
[Automatic image builds](#automatic-image-builds). Building it up front just
means the first login isn't waiting on it.

### 2. Build the bastion image
```bash
docker compose build bastion
```

### 3. Configure
```bash
cp .env.example .env
# Edit .env — JWT_SECRET is required:
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
```

`bos-net` needs no manual setup — Compose creates it automatically on first `up`. It stays Compose-managed (not `external`), so a `docker compose down`/`up` cycle *will* recreate it with a new ID; the bastion detects and repairs any user container left pointing at the old ID automatically (at startup, and defensively before every restart), so this never requires operator intervention.

### 4. Create an admin user (Simple auth)
```bash
# Start the bastion first, then create a user via the API:
docker compose up -d bastion

curl -s -X POST http://localhost/admin/users \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme","isAdmin":true}'
# Note: this requires a session cookie — seed users.yml directly for bootstrap:
```

Or bootstrap by writing `bastion-data:/data/users.yml` directly:
```bash
docker compose exec bastion sh -c "cat > /data/users.yml" << 'EOF'
users:
  admin:
    passwordHash: $(docker compose exec bastion node -e "const b=require('bcryptjs');console.log(b.hashSync('changeme',12))")
    admin: true
EOF
```

### 5. Log in
Visit `http://localhost` — you will be redirected to the login page.

---

## Simple auth setup

`AUTH_PROVIDER=simple` (the default) reads users from `/data/users.yml` inside the bastion container (persisted to the `bastion-data` Docker volume).

### File format
```yaml
users:
  alice:
    passwordHash: "$2b$12$..."
    admin: true
  bob:
    passwordHash: "$2b$12$..."
    admin: false
```

### Generate a password hash
```bash
node -e "const b = require('bcryptjs'); console.log(b.hashSync('mypassword', 12));"
```

The file is hot-reloaded by `chokidar` — changes take effect immediately without a bastion restart.

### Login audit log

Every credential check made by the simple provider is appended to
`/data/audit/login.log` inside the bastion container (the `bastion-data`
volume), one JSON object per line — `bastion/src/audit-log.ts`:

```json
{"ts":"2026-09-16T09:12:44.118Z","event":"login","outcome":"failure","username":"alice","reason":"bad_password","isAdmin":null,"ip":"::ffff:10.0.0.4","forwardedFor":"203.0.113.9","userAgent":"Mozilla/5.0 …"}
```

- `event` — `login` (a credential check against `POST /login`) or
  `bootstrap_admin` (first-run setup minting the initial admin session, the one
  path that grants a session without a credential check).
- `reason` — on failure: `unknown_user`, `bad_password`, `missing_credentials`
  or `provider_error`. The HTTP response deliberately collapses the first two
  into a single "Invalid credentials" to avoid user enumeration; the log keeps
  them apart, which is what makes a credential-stuffing sweep legible
  afterwards. Passwords are never recorded.
- `ip` is the TCP peer — i.e. the reverse proxy's address when one sits in
  front of the bastion. `forwardedFor` is the raw `X-Forwarded-For` header,
  client-controlled and spoofable unless a trusted proxy overwrites it; the two
  are kept separate rather than collapsed so the log never implies more
  certainty than it has.

The active file rotates at 5 MB, keeping `login.log.1` … `login.log.5` (so an
unauthenticated login flood cannot fill the disk). It is deliberately **not**
under `/data/logs/`, which holds per-user provisioning logs that are surfaced
in the admin UI and deleted along with the user.

**Keycloak deployments have no such file.** There the IdP performs the
credential check and owns that trail; the bastion never sees a password, so
`initAuditLog()` disables the module outright for any non-simple provider.

Tail it with:
```bash
docker compose exec bastion tail -f /data/audit/login.log
```

---

## Keycloak setup

### 1. Start with the Keycloak override
```bash
docker compose -f docker-compose.yml -f docker-compose.keycloak.yml up -d
```

This starts Keycloak on port 8080 with the bundled `bos` realm pre-imported.

### 2. Configure bastion
In `.env`:
```env
AUTH_PROVIDER=keycloak
KEYCLOAK_ISSUER=http://keycloak:8080/realms/bos
KEYCLOAK_CLIENT_ID=bos-bastion
KEYCLOAK_CLIENT_SECRET=change-me-in-production
```

### 3. Add redirect URI in Keycloak admin
Log in at `http://localhost:8080` (admin/admin), navigate to `Clients → bos-bastion → Settings`, add `http://localhost/auth/callback` to Valid redirect URIs.

---

## Headless (non-browser) client auth

A request with no session cookie but a parseable `Authorization: Basic
<...>` header is routed by `bastion/src/credential-routing.ts`, independent
of `AUTH_PROVIDER`: it hashes the presented password and scans every
provisioned user's `data/system/credentials-index.json` for a match — never
by asking Keycloak or the simple-auth users file to resolve a username, and
without any identity-provider admin-API credential configured anywhere. This
means it behaves identically under both auth providers, and — critically for
Keycloak, where Bastion holds no local user directory — works even though
Bastion cannot ask "who owns this credential" at all.

That companion index is written by any BOS service that mints a credential
through `src/lib/secrets/service-secrets.ts`. Adding a new headless-auth
service requires **no Bastion changes** — see
`docs/dev/features/headless-client-auth.md` for the full mechanism and how a
BOS feature adopts it.

---

## Automatic image builds

`BOS_IMAGE` (default `browseros:latest`) is the one prerequisite a user
container cannot be created without, and it is shared by every user — there is
no per-user image. `ensureBosImage()` therefore runs inside
`createBosContainer()` in `bastion/src/docker.ts`, the single place
`cfg.bosImage` is ever used: if the tag is missing it is built from
`BOS_REPO_PATH` (default `/bos-src`, the deployment's own source checkout)
before the container is created.

Putting it at that choke point means every path that makes a container is
covered by construction — first provision, `rebuild-nm`, `reset-data`, full
re-provision, and the stale-container self-heal in `lifecycle.ts` — rather
than each remembering to check. Before this, creating a user in the admin
portal and logging in as them died on the daemon's `No such image: <tag>`,
and an operator had to notice and press **Build image** in the admin portal
by hand before *any* user could log in.

Notes:

- **Progress is visible.** The build takes minutes on a cold deployment, so
  `Step n/m` lines are reported through the provisioning log — the same
  channel the "starting your instance" status page polls. Without that the
  first login looks like a hang.
- **One build per tag.** `buildImageCoalesced()` holds a single in-flight
  build per tag, shared by the automatic path *and* the admin portal's
  explicit **Build image** action (whose `409 "A build is already in
  progress"` now reflects both). Two first-time logins at once, or an admin
  build racing a login, join one build instead of racing on the tag. Only the
  caller that started it streams progress.
- **Failure is diagnosable.** A failed build raises `Image "<tag>" is missing
  and could not be built automatically from <path>: <reason>`, and the tag is
  re-checked against the daemon afterwards, so a build that "succeeds"
  without producing the tag fails here rather than later at
  `createContainer`.
- It does **not** rebuild an image that already exists. Updating a
  deployment's image is still an explicit action (admin portal → Build image,
  or `docker build` on the host).

Regression cover: `tests/bastion/image-autobuild.test.ts` (real Docker
integration tests; they self-skip when no daemon is reachable).

---

## WebSocket upgrades through the Bastion

A WebSocket upgrade does **not** go through Express. `server.on("upgrade")` is
an event on the HTTP server itself, so none of the middleware stack runs for
it: not the auth router, not the proxy middleware, not even `cookie-parser`.
Everything an upgrade needs is therefore done explicitly by
`createBosProxy(...).upgrade(server)`, which `bastion/src/index.ts` must call
with the server the middleware is mounted on:

1. Strip any client-supplied `x-bos-auth-scope`/`x-bos-auth-role` headers.
2. Authenticate — the session JWT read straight out of the raw `Cookie`
   header (`verifySessionToken` + `sessionTokenFromCookieHeader`), or a
   headless per-service secret via the same `resolveCredential` path HTTP
   uses. There is no `/login` redirect fallback: a 302 means nothing to a
   WebSocket client, so an unauthenticated upgrade is refused outright with
   `401` + `WWW-Authenticate` written onto the raw socket.
3. Assert the verified claim headers, plus `x-bos-username`. (The HTTP path
   injects that one via http-proxy's `proxyReq` hook, which is **not** emitted
   for upgrades — it emits `proxyReqWs` — so the upgrade path sets it on the
   request's own headers, which are what get forwarded.)
4. Dispatch to exactly one user's proxy instance. A WebSocket cannot wait out
   a cold start the way the HTML status page does, so an instance that isn't
   `running`/`unhealthy` yet is refused with `503` rather than triggering
   provisioning; the page that opened the socket is itself served over HTTP,
   which does start the instance.

### The per-user proxies must keep `ws: false`

`createBosProxy` builds one `createProxyMiddleware` instance **per user**, each
pinned to that user's own container. Setting `ws: true` on them is a latent
outage plus an auth bypass, and both halves actually happened:
http-proxy-middleware lazily self-subscribes to the shared server's `upgrade`
event on each instance's first HTTP request, and Node invokes **every**
`upgrade` listener for **every** upgrade. With N users active, one WebSocket
was proxied into all N containers at once — N `101 Switching Protocols`
responses written onto a single client socket, which breaks the connection (the
Terminal app stopped working this way) — and because that self-subscribed
listener runs outside Express, it performed **no authentication at all**,
making every provisioned user's container reachable by an unauthenticated
upgrade. Keep `ws: false` and let `attachUpgrade()` own the dispatch.
Regression cover: `tests/bastion/proxy-ws-upgrade-auth.test.ts`.

Bastion serves no WebSocket of its own (the admin log stream is SSE, i.e.
plain HTTP), so the single upgrade listener is deliberately a catch-all.

---

## Volume layout

```
VOLUME_BASE/               (default: ./user-data on the host)
  {username}/               ←── bind → /bos   (covers data/ + data-clones/)
    src/          ←── git clone of BOS source (bind → /app)
    data/         ←── BOS_DATA_DIR       (bind → /app/data)
                       …also reachable as /bos/data (BOS_CLONE_SOURCE)
    worktrees/    ←── BOS_WORKTREES      (bind → /worktrees)
    data-clones/  ←── BOS_DATA_CLONES = /bos/data-clones

Docker named volumes:
  bos-nm-{username}  ←── /app/node_modules (per user)
  bastion-data       ←── /data inside bastion (users.yml, instances.json, config.json,
                          logs/<user>.log provisioning logs, audit/login.log)
```

`worktrees/` and `data-clones/` sit outside `/app` so `chown -R /app` never walks
them (a worktree is a full source tree plus `node_modules`; a clone is a full copy
of `data/`).

> **Why the user's directory is bound a second time at `/bos`.** `link(2)`
> refuses to cross a mount even when both paths are on one filesystem. With
> `data/` and `data-clones/` bound separately, `cp -al /app/data /data-clones/…`
> failed with `EXDEV` on every file, the clone layer fell back to `cp -a`, and
> every preview clone was a full copy of the user's `data/` — 8.5 GB each, which
> is how a production host filled 155 GB. Two directories share a mount only if
> one mount covers both, so the covering parent is bound once at `/bos` and the
> Supervisor clones `/bos/data` → `/bos/data-clones`, one mount, real hardlinks.
>
> `BOS_DATA_DIR` stays `/app/data` on purpose: `installItemLink` writes
> `data/system/<id>` as an **absolute** symlink, so re-addressing the data dir
> would break every installed item in every existing container. Only the
> Supervisor's clone layer reads `BOS_CLONE_SOURCE`. See
> [DataFS](self-modification/data-isolation-datafs.md).

### The instance registry is a cache

`/data/instances.json` is written temp-then-rename and its write failures are
contained, not propagated: `reconcileOnStartup` rebuilds it from `docker ps` on
every boot, and its most frequent writer is `touchInstance` — a cosmetic
"last active" timestamp on every proxied request, coalesced to at most one write
per 5 s. A bare `writeFileSync` here once truncated the registry to zero bytes on
a full disk and served the resulting `EDQUOT` stack trace to every user on every
page. Failures are logged with their cause; see
`tests/bastion/instances-persist-atomic.test.ts`.

### Ownership of the data mount

The bastion creates `{username}/data/` as **root**; BOS inside the container runs as
`user` (uid `BOS_UID`, default 1000). `docker-entrypoint.sh` reconciles the two, and
the ordering is load-bearing:

1. `chown -R user:user /app/data` — **only when `/app/data`'s own owner differs from
   `BOS_UID`**. It is a cheap guard against re-walking a large data tree on every
   start, but it inspects the top directory alone: a root-owned directory *inside* an
   already-user-owned `data/` is invisible to it and never repaired.
2. The VFS block then creates `data/vfs/{workspace,Documents}` — still as root, i.e.
   *after* step 1 has been and gone. So it must chown **the `vfs/` root itself**, not
   just the leaves it symlinks. Leaving `vfs/` root-owned makes the container come up
   healthy with a VFS the BOS process cannot extend: `ensureVfs()` in `src/os/vfs.ts`
   fails with `EACCES ... mkdir '/app/data/vfs/Pictures'`, and every subsystem whose
   first act is a VFS write (the memory plugin's scheduler seeding, for one) dies with
   it. The chown is unconditional so an already-broken container self-repairs on its
   next start.

Anything else added to the entrypoint that creates a directory under the data mount as
root carries the same obligation. `tests/bastion/docker-entrypoint-vfs-ownership.test.ts`
enforces it by replaying the script's `mkdir`/`chown` sequence under shims.

---

## Base serving mode (`BOS_BASE_DEV`)

Spawned user containers get `BOS_BASE_DEV=0` (`bastion/src/docker.ts`), so the
Supervisor **builds** base and serves it with `next start`. Do not set this to
`1` for a deployment. Measured on the same code and the same request load:

| | `next dev` | `next start` |
|---|---|---|
| RSS at boot | 2181 MB | 130 MB |
| Per API request | +0.78 MB | +0.054 MB |
| 4 min sustained load | 2.4 → 7.1 GB, no plateau | 198 → 249 MB, plateaued |

`next dev` keeps Turbopack's compiler resident and grows without bound; on a
16 GB host it reached a 15.8 GB peak and was OOM-killed by the kernel. Previews
have always run in production mode (`next build` + `next start` per worktree),
and the promote path for a production base is the stronger one — a health-gated
swap on the base port that restores the old base if the candidate doesn't come up.

The trade-offs are real: a cold container start and every promote now include a
`next build`, and edits made directly to the live checkout no longer hot-reload
onto base (go through a preview + promote instead). `STARTUP_TIMEOUT_MS` in
`bastion/src/lifecycle.ts` and the image's `HEALTHCHECK --start-period` are both
sized for that build.

### Bounding dev mode (local development)

`BOS_BASE_DEV=1` is still the right mode for local work (`run-dev-supervisor.sh`).
There, the Supervisor caps the dev server's heap:

| Env var | Default | Effect |
|---|---|---|
| `BOS_DEV_MAX_OLD_SPACE_MB` | `2048` | `--max-old-space-size` for the dev base; `0` disables the cap |

At the cap, Next's own dev memory guard fires (`⚠ Server is approaching the used
memory threshold, restarting…`) and recycles the server gracefully rather than
growing until the kernel kills it. Two measured caveats: this bounds the **heap**,
not total RSS — about half the footprint is outside V8's old space, so expect RSS
≈ 2× the cap — and it is a **bound, not a fix**. What retains memory per-request
in dev is still unexplained; production mode does not exhibit it.

---

## System Monitor

`/app/admin` → **System Monitor** is the first tab, and `GET /admin/monitor`
(admin-only) is the same data as JSON. It exists because "the container is
running" says nothing about whether BOS works: the Supervisor is PID 1 inside
each container, so it survives the death of the base Next.js server — a
container reported `Up` for 10 hours on 2026-07-29 while BOS inside it was dead.

What it shows, and why each field is there:

| Field | Answers |
|---|---|
| `serving` vs container `status` | Is BOS actually responding, or just "Up"? |
| Docker `Healthcheck` verdict | The image's own `HEALTHCHECK` probes `/__supervisor/health` |
| Base **mode** (dev / production / reused) | Dev mode in production is what caused the OOM — flagged in red |
| Base process alive + pid | Distinguishes "supervisor up, base dead" from "container down" |
| **Base restarts** | Makes a crash-restart loop visible instead of letting supervision hide it |
| **Last base exit** (code **and signal**) | A SIGKILL, or a code-0 exit from a serving process, means an OOM kill. `next dev` exits 0 when its child is OOM-killed, which masked the original outage |
| Memory used / peak / limit | Headroom; `limit: none` warns that one tenant can take the host down |
| **OOM kills** (cgroup `oom_kill`) | Proves the kernel reaped something. `oom: 0` alongside it means the HOST ran out, not the container's own limit |
| Host total memory + per-container usage | Whether the box as a whole is near the edge |

The bastion also re-checks every instance every 30 s in the background, so an
instance that stops serving flips to `unhealthy` (distinct from `stopped`) in the
Containers tab and is logged as a transition rather than silently ignored.

---

## Re-provisioning

Users can self-service from `/app/account`. Admins can use `/app/admin`.

| Operation | What it does |
|---|---|
| `restart` | Stop + start the container |
| `pull-and-update-src` | `git fetch` + **merge** in `src/`, clear `.next/`, restart — **keeps** your local commits |
| `update-src` | `git fetch` + **`reset --hard`** in `src/`, clear `.next/`, restart — **discards** your local commits |
| `rebuild-nm` | Wipe `node_modules` volume, restart (npm install on startup) |
| `reset-data` | Wipe `data/`, restart |
| `full` | Full deprovision + reprovision (destroys everything, requires confirm) |

### Two ways to update the source

`src/` is a real working checkout, not a read-only mirror: the Supervisor commits
candidates there, and a **promote lands a commit on the base branch in that very
checkout**. So the choice matters.

- **`pull-and-update-src`** — fetch, then fast-forward if possible, otherwise
  merge. Local commits survive. Every failure path is a no-op: it refuses up-front
  if the tree is dirty (naming the files; `package-lock.json` churn is exempt),
  checks out an *existing* local branch rather than `checkout -B`, and on conflict
  runs `merge --abort` so `HEAD` and the working tree are left exactly as they were.
- **`update-src`** — fetch, then `reset --hard FETCH_HEAD`. The checkout ends up
  byte-identical to the remote, and **any local commits are gone**. Right when you
  want a known-good state; wrong when the user has work in there.

Both clear `.next/` afterwards — `reset --hard` preserves gitignored directories,
and a stale Turbopack cache from the previous installation makes certain API routes
fail after an update — then fix ownership and restart.

Implemented as one function with a `mode` parameter (`reprovisionUpdateSrc(user, cfg, "reset" | "pull")`)
so the shared work — credential resolution, stopping the container, fetching,
cache clearing, chown, restart — cannot drift between the two.

### The source checkout must have history (the shallow-clone trap)

Per-user clones fetch from **the deployment's own checkout**, not from GitHub/GitLab:

```
data/user-apps ... irrelevant here
{VOLUME_BASE}/{user}/src   remote "bos-default"  ->  /bos-src
/bos-src                   bind mount of the platform's working copy
                           (Dokploy: /etc/dokploy/compose/<app>/code)
```

If that checkout is **shallow**, every source update breaks:

```
git -C /user-data/alex/src fetch bos-default claude
  error: Could not read 22bb6ce91…
  fatal: revision walk setup failed
  error: /bos-src did not send all necessary objects
```

A shallow remote has no connecting history to send, and no merge base to offer.
Both buttons fail — this is not specific to `pull-and-update-src`.

**Dokploy makes this the default state.** It clones with `--depth 1
--single-branch` *and deletes and re-clones `code/` on every redeployment*. There
is no clone-depth setting to change, and a manual `git fetch --unshallow` in
`code/` is wiped by the next deploy. Observed on a real deployment:

```
/bos-src   is-shallow: true   rev-list --count HEAD: 1
.git/config  remote.origin.fetch = +refs/heads/claude:refs/remotes/origin/claude
.git/logs/HEAD contains exactly one "clone:" line   ← re-cloned every deploy
```

**So the repair runs automatically, at bastion startup**
(`ensureSourceRepoHasHistory` in `bastion/src/provision.ts`, awaited from
`index.ts` before the server accepts traffic):

- if `bosRepoPath` is shallow and has a remote → `git fetch --unshallow`
- idempotent — a complete repo short-circuits, and git's own
  `--unshallow on a complete repository does not make sense` is treated as success
- never fatal — an unreachable remote degrades, it does not stop the bastion
- awaited, so a user cannot start a source update that races it

`pull-and-update-src` additionally tries to deepen the **user's** clone, because a
clone taken from a shallow source is itself shallow.

When history genuinely cannot be obtained:

| Mode | Behaviour |
|---|---|
| `update-src` | fetches with `--depth=1` — no history walk, so it works. Applied **only** when the clone is already shallow; passing `--depth=1` to a full clone would truncate real history |
| `pull-and-update-src` | refuses, saying the source is shallow and there is no merge base |

### The same trap hits Settings → Versions → Push

The per-remote **Push** button (`src/app/api/git-remotes/route.ts`, case
`"push"`) operates on this exact checkout, so a shallow re-clone can reject an
otherwise-fine push as non-fast-forward: git has no connecting history to
prove the local branch descends from the remote's.

The route now recovers automatically instead of just reporting the error —
mirroring what **Pull** (`case "fetch"`) already did for the same situation:

1. If the repo is shallow (`isShallowRepo`), `unshallowRepo` runs `git fetch
   --unshallow <remote>` against the *target* remote before anything else —
   the same technique as `ensureSourceRepoHasHistory` above, just scoped to
   whichever remote the push failed against (which may not be `bos-default`).
2. Fetch the branch and recompute the merge-base. No shared history →
   `unrelatedHistory: true` (same shape Pull returns; the UI offers "Adopt").
3. Shared history but diverged → try `rebaseOntoRemote`, then retry the push
   once. A clean rebase makes the retry a plain fast-forward.
4. Rebase conflicts → `rebaseConflict: true` (same shape Pull returns; the UI
   offers "Force push").

An auth failure short-circuits this (no point re-fetching), and an explicit
force-push (`force: true`) skips it entirely — force-with-lease either
succeeds or fails outright.

Two operational notes from the field:

- The platform may **modify files in the deploy checkout** — `docker-compose.yml`
  was found dirty on the server, which means the running compose is not
  necessarily byte-identical to what you committed.
- Dokploy embeds an OAuth token directly in `remote.origin.url`
  (`https://oauth2:<token>@…`), readable by anything that can exec into the
  bastion. Consider a deploy key instead.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | — | **Required.** Signs session cookies. |
| `AUTH_PROVIDER` | `simple` | `simple` or `keycloak` |
| `BOS_IMAGE` | `browseros:latest` | Docker image for user containers |
| `BOS_BASE_REF` | `main` | Git ref to clone for new users' `src/` |
| `BASTION_PORT` | `80` | Host port for the bastion |
| `PUBLIC_URL` | `http://localhost` | Public URL (used for OIDC callback) |
| `VOLUME_BASE` | `./user-data` | Host path for per-user volumes |
| `MAX_CONCURRENT_INSTANCES` | `50` | Max simultaneous running containers |
| `KEYCLOAK_ISSUER` | — | OIDC issuer URL |
| `KEYCLOAK_CLIENT_ID` | — | OIDC client ID |
| `KEYCLOAK_CLIENT_SECRET` | — | OIDC client secret |
| `KEYCLOAK_USERNAME_CLAIM` | `preferred_username` | JWT claim for BOS username |
| `KEYCLOAK_ADMIN_ROLE` | `bos-admin` | Keycloak role that grants admin access |

---

## Development

```bash
# Run bastion in dev mode (hot-reload via ts-node-dev)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up bastion

# Or run the bastion locally (requires Docker socket access):
cd bastion && JWT_SECRET=dev npm run dev

# Run the Vite UI dev server separately:
cd bastion/ui && npm install && npm run dev
# then visit http://localhost:5173/app/
```
