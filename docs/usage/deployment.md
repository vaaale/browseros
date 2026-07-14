# BrowserOS — Docker Multi-User Deployment

## Architecture

```
Browser ──► bastion:80 ──► bos-{username}:8090 (Supervisor)
```

The bastion handles authentication, per-user container lifecycle, and proxies all HTTP and WebSocket traffic to each user's BOS instance. Containers are spawned dynamically on first login and stopped after an idle timeout.

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

### 3. Create the network (once only)

`bos-net` is declared `external` in compose so it is never recreated on `compose up`. Create it once before first start — and once only, ever:

```bash
docker network create bos-net
```

### 4. Configure
```bash
cp .env.example .env
# Edit .env — JWT_SECRET is required:
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
```

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

## Re-provisioning

Users can self-service from `/app/account`. Admins can use `/app/admin`.

| Operation | What it does |
|---|---|
| `restart` | Stop + start the container |
| `update-src` | `git pull` in `src/`, restart |
| `rebuild-nm` | Wipe `node_modules` volume, restart (npm install on startup) |
| `reset-data` | Wipe `data/`, restart |
| `full` | Full deprovision + reprovision (destroys everything, requires confirm) |

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
| `IDLE_TIMEOUT_MS` | `1800000` | Idle timeout before container stops (ms) |
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
