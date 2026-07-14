# Quickstart — Docker with Simple Auth

Deploy BrowserOS for a team using Docker Compose. The **Bastion** acts as a reverse proxy and authenticates users with a local username/password store (`users.yml`). Each user gets an isolated BOS container — their own desktop, files, and assistant — spawned on first login.

## Architecture

```
Browser
  │  HTTP/WS
  ▼
Bastion :80          ← authentication, proxy, admin portal
  │  HTTP
  ▼
bos-{username} :8090 ← per-user BrowserOS container (Supervisor + Next.js)
```

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Docker Engine | 24 (rootful) |
| Docker Compose | v2 (`docker compose`) |
| Git | any |
| 2 GB free RAM per concurrent user | — |

## 1. Clone the repository

```bash
git clone https://github.com/your-org/browseros.git
cd browseros
```

## 2. Build Docker images

Build both images once before starting the stack. This takes a few minutes the first time (LibreOffice and the Claude/OpenCode CLIs are bundled into the BOS image):

```bash
# BOS user-container image (also the run_command sandbox environment)
docker build -t browseros:latest .

# Bastion image
docker build -t bos-bastion:latest ./bastion
```

> **Tip:** You can also add `--platform linux/amd64` if building on Apple Silicon for a Linux target host.

## 3. Create the Docker network

The bastion and user containers communicate over a shared bridge network. Create it once:

```bash
docker network create bos-net
```

## 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set the values below. Everything else has a working default.

### Required

```env
# Generate a random secret: openssl rand -hex 32
JWT_SECRET=<your-64-char-hex-secret>

# Your Anthropic API key — seeded into each user container
ANTHROPIC_API_KEY=sk-ant-...
```

### Recommended

```env
# Auth mode (default is "simple")
AUTH_PROVIDER=simple

# The Docker image for user containers (matches what you built above)
BOS_IMAGE=browseros:latest

# Public URL the browser connects to — used in redirects and OIDC callbacks
# Set to your server's hostname or IP if not running on localhost
PUBLIC_URL=http://localhost

# Host port for the bastion (default 80; change if port 80 is taken)
BASTION_PORT=80

# Host directory for per-user data (Docker bind-mount source — must be absolute)
# The path on the HOST machine, not inside any container.
VOLUME_BASE_HOST=/absolute/path/to/user-data
VOLUME_BASE=./user-data   # used by the bastion internally — keep in sync
```

### Example `.env` for a LAN server at `192.168.1.10`

```env
JWT_SECRET=835816da21dd0fc05a93394ccddc194c0b3b0363d310c0e218624ec4625ee663
ANTHROPIC_API_KEY=sk-ant-...
AUTH_PROVIDER=simple
BOS_IMAGE=browseros:latest
PUBLIC_URL=http://192.168.1.10
BASTION_PORT=80
VOLUME_BASE_HOST=/srv/bos/user-data
VOLUME_BASE=./user-data
```

## 5. Start the stack

```bash
docker compose up -d
```

The bastion will be available at `http://localhost` (or your `PUBLIC_URL`) within a few seconds.

## 6. First-run — set the admin password

On first visit the bastion detects no admin user and shows a **Set admin password** page instead of the normal login.

Enter and confirm a password (minimum 8 characters). The admin account is created with username `admin` (override with `ADMIN_USER=myname` in `.env`). You are immediately logged in as admin and redirected to the admin portal.

> **Race safety:** if two operators submit the form simultaneously, only one admin is created; the second request gets a clear "already configured" error.

## 7. Admin portal — manage users and containers

After setting the admin password you land in the **Admin Portal**. It has four tabs:

### Users tab

Create accounts for your team. Each user gets an isolated BOS instance on first login.

| Field | Notes |
|-------|-------|
| Username | `[a-z0-9_-]` only — used as container and volume names |
| Password | Minimum 8 characters |
| Admin | Grants access to this admin portal |

### Images tab

Build or select the Docker image used for new user containers. The image bundles the BOS source, run_command runtimes (Python, Node, LibreOffice), and the Claude/OpenCode CLIs.

- **Dockerfile** — path relative to the repo root (default: `Dockerfile`)
- **Tag** — image tag to push to (default: `browseros/user:latest`)
- Click **Build** — the build log streams live into the page
- Click **Set active** — new containers will use this image

### Containers tab

Lists every user container with live status. Actions: **Start**, **Stop** (graceful), **Kill** (force-remove).

### Logs tab

Per-user provisioning log — the first place to look when a container fails to start.

## 8. User first login

Direct your users to `http://<your-host>/`. They log in with the credentials you created. On first login:

1. The bastion clones the BOS source into `user-data/<username>/src/`
2. A Docker container is created and started
3. A loading page streams progress until the Supervisor and Next.js are healthy
4. The user lands on their own BrowserOS desktop

Each user's files, settings, and conversation history are isolated under `user-data/<username>/data/`.

## 9. User account page

Each user can manage their own instance at `/app/account`:

- **Start / Stop / Restart** their container
- **Upload a profile image** (shown in the BOS toolbar)
- **Change password**
- **View provisioning log** (if something went wrong)
- **Wipe my data** — destroys VFS files and conversation history (confirmation required)

The toolbar in their BOS desktop shows their avatar and a **My profile** link back to this page.

## Managing the stack

### Stop all containers

```bash
docker compose down
```

User containers (spawned by the bastion) are stopped separately because they are not in the Compose file. Find and stop them:

```bash
docker stop $(docker ps -q --filter "name=bos-")
```

### Restart after reboot

```bash
docker compose up -d
```

The bastion reconciles running containers on startup. Containers that were running before the restart are detected and their state is restored.

### Add or remove users

Use the **Users** tab in the admin portal. Removing a user:
1. Stops and removes their container
2. Wipes `user-data/<username>/` (src, data, and node_modules volume)
3. Deletes their provisioning log and avatar

A confirmation dialog is shown before the wipe.

### Change the BOS image for new containers

Build the new image (Images tab or `docker build`), then use **Set active** in the Images tab. Existing running containers are not affected; they pick up the new image on their next start/reprovision.

## Upgrading BOS

```bash
git pull
docker build -t browseros:latest .
# In the admin portal → Images → Build, or rebuild manually above
# Then stop/start user containers to pick up the new image
```

## Environment variable reference

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | _(required)_ | Secret for signing session tokens |
| `AUTH_PROVIDER` | `simple` | `simple` or `keycloak` |
| `BOS_IMAGE` | `browseros:latest` | Docker image for user containers |
| `BASTION_PORT` | `80` | Host port for the bastion |
| `PUBLIC_URL` | `http://localhost` | Public-facing URL (used in redirects) |
| `VOLUME_BASE` | `./user-data` | Bastion-internal path for user data |
| `VOLUME_BASE_HOST` | `$PWD/user-data` | Host path for Docker bind mounts |
| `IDLE_TIMEOUT_MS` | `1800000` | ms before idle containers are stopped (30 min) |
| `MAX_CONCURRENT_INSTANCES` | `50` | Max simultaneously running user containers |
| `BOS_BASE_REF` | `main` | Git branch to clone for each new user |
| `ADMIN_USER` | `admin` | Username for the bootstrap admin account |

## Troubleshooting

**Container stuck in "provisioning"** → check the per-user log in Admin Portal → Logs, or look at `docker logs bos-<username>`.

**"Max concurrent instances reached"** → increase `MAX_CONCURRENT_INSTANCES` in `.env` and restart the bastion.

**Port 80 already in use** → set `BASTION_PORT=8080` (or any free port) in `.env`.

**User gets a 502 Bad Gateway** → the user container is not healthy. Check the provisioning log and try **Restart** from the Containers tab.

## Next steps

- [Docker + Keycloak](./docker-keycloak.md) — replace simple auth with enterprise SSO
- [docs/usage/deployment.md](../deployment.md) — full deployment reference
