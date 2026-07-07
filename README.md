# BrowserOS

BrowserOS (BOS) is an agentic operating system that runs in the browser. It has a desktop, draggable windows, a dock, and a built-in AI assistant that can operate the OS, manage files, browse the web, install apps, and modify BOS itself — including writing and previewing its own code changes on a live branch.

---

## Getting started

There are two ways to run BOS:

| Mode | When to use |
|---|---|
| **Dev mode** (single user) | Local development, trying BOS out, contributing |
| **Docker Compose** (multi-user) | Shared team instance, production, or self-hosted deployment |

---

## Dev mode (single user)

### Prerequisites

- Node.js 20+ and npm
- Git
- An API key for an AI provider (Anthropic, OpenAI, or a local OpenAI-compatible server)

### 1. Clone and install

```bash
git clone <repo-url>
cd browseros
npm install
```

### 2. Configure

```bash
cp .env.example .env.local
# Edit .env.local — set your API key:
#   ANTHROPIC_API_KEY=sk-ant-...
```

The minimum required setting is an AI provider key. Everything else is configurable at runtime in Settings.

### 3. Run

**With the Supervisor** (recommended — enables live version control, branch previews, and safe self-modification):

```bash
BOS_BASE_DEV=1 BOS_PORT_BASE=3000 BOS_PUBLIC_PORT=8090 npm run supervisor
```

Open **http://localhost:8090**

**Without the Supervisor** (plain Next.js dev server, no self-modification):

```bash
npm run dev
```

Open **http://localhost:3000**

### 4. First-time setup

On first launch a setup wizard appears. It configures:

1. **AI Provider** — which model powers the assistant (Anthropic / OpenAI / local)
2. **Dev Harness** — how the assistant runs the autonomous coder for development tasks (Claude CLI headless is the default)
3. **Data Isolation** — how preview data is isolated from live data during self-modification

You can skip the wizard and configure everything from **Settings** at any time.

---

## Docker Compose (multi-user)

For multi-user deployments, BOS ships a **bastion** service that handles authentication, spawns per-user BOS containers dynamically, and proxies traffic to them.

```
Browser → bastion:80 → bos-{username}:8090
```

Each user gets their own isolated source tree, data directory, and `node_modules` volume.

### Prerequisites

- Docker Engine 24+ and Docker Compose
- Git

### 1. Build the BOS image

```bash
docker build -t browseros:latest .
```

### 2. Configure

```bash
cp .env.example .env
# Required — generate a secret:
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
```

### 3. Start

```bash
docker compose up -d
```

Visit **http://localhost** — you will be presented with a login page.

### 4. Create the first admin user

With the bastion running, write a `users.yml` into its data volume:

```bash
docker compose exec bastion sh -c 'cat > /data/users.yml << EOF
users:
  admin:
    passwordHash: $(docker compose exec bastion node -e "const b=require('"'"'bcryptjs'"'"');console.log(b.hashSync('"'"'changeme'"'"',12))")
    admin: true
EOF'
```

Then log in at **http://localhost** with `admin` / `changeme` and change your password from the account page.

### Auth providers

| Provider | Config |
|---|---|
| **Simple** (default) | Users defined in `/data/users.yml` inside bastion. Bcrypt passwords, hot-reloaded. |
| **Keycloak** | Set `AUTH_PROVIDER=keycloak` and `KEYCLOAK_*` vars. Use the Keycloak compose override. |

```bash
# Start with a local Keycloak (bundled bos realm pre-imported):
docker compose -f docker-compose.yml -f docker-compose.keycloak.yml up -d
```

See [docs/dev/deployment.md](docs/dev/deployment.md) for the full deployment guide including Keycloak setup, volume layout, idle timeout, and re-provisioning.

---

## AI provider setup

BOS supports any OpenAI-compatible provider. Configure in **Settings → AI Provider** at runtime, or seed defaults in `.env.local`:

| Provider | Key to set |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY=sk-ant-...` |
| OpenAI | Configure base URL and key in Settings |
| Local (vLLM, Ollama, etc.) | `ANTHROPIC_BASE_URL=http://...` and `ANTHROPIC_API_KEY=local` |

---

## Developer harness

For the AI assistant to write and preview code changes, it needs a developer harness — an autonomous coder it can delegate to. The default is **Claude CLI (headless)**, which requires Claude Code to be installed on the machine running BOS:

```bash
npm install -g @anthropic-ai/claude-code
```

Then configure the harness URL in **Settings → Dev Harness**. Without a harness, all BOS features work except self-modification.

---

## Documentation

- **[docs/usage/](docs/usage/introduction.md)** — using BOS (the desktop, apps, assistant, memory, settings)
- **[docs/dev/](docs/dev/architecture-overview.md)** — extending and modifying BOS (architecture, API reference, recipes)
- **[docs/dev/deployment.md](docs/dev/deployment.md)** — full Docker multi-user deployment guide

The in-OS **Docs app** renders these trees inside BOS itself.

---

## Development workflow

```bash
npm run dev          # plain Next.js (port 3000)
npm run supervisor   # with Supervisor (port 8090, enables self-modification)
npx tsc --noEmit     # typecheck
npm run lint         # lint
npm run test:e2e     # Playwright e2e tests
```

BOS follows a spec-first workflow: features are specified in **Build Studio** before being implemented. See `specs/bos-system-specs/` and `docs/dev/architecture-overview.md`.
