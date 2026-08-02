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

## Volume layout

```
VOLUME_BASE/               (default: ./user-data on the host)
  {username}/
    src/   ←── git clone of BOS source (bind → /app/src)
    data/  ←── BOS_DATA_DIR (bind → /app/data)

Docker named volumes:
  bos-nm-{username}  ←── /app/node_modules (per user)
  bastion-data       ←── /data inside bastion (users.yml, instances.json, config.json)
```

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
