# BrowserOS

**An operating system that runs in your browser — and rewrites itself.**

BrowserOS (BOS) has a desktop, draggable windows, a dock, and a built-in AI assistant that can operate the OS, manage files, browse the web, and install apps — just like you'd expect. What it isn't supposed to do is modify its own source code, live, on a branch you can preview before merging. But it does that too.

Clone it, run one command, and in a couple of minutes you'll have your own self-improving desktop with an assistant that can talk to you, show you its face, and build new apps and skills for itself on request.

![Desktop](./docs/assets/BOS%20Intro.png)

## Why people like it

- **A real desktop, not a demo** — windows, a dock, Files, Settings, and a growing set of built-in apps.
- **An assistant that can act, not just chat** — it browses the web, edits files, runs commands, and delegates to sub-agents for bigger jobs.
- **Self-modifying, safely** — the assistant writes and previews BOS's own code on an isolated branch before anything touches your live instance.
- **A Marketplace, not a plugin folder** — add apps, assistant skills, and spec templates from any git repo with one URL.
- **Talk to it, see it** — voice conversations with an optional animated avatar, not just a text box.
- **Bring your own AI** — Anthropic, OpenAI, a local model, and either Claude Code or OpenCode as the coding backend — your keys, your choice.

---

## Marketplace

BOS has a built-in **Marketplace** app that lets you extend the OS with apps, assistant skills, and spec templates published in external git repositories. Just paste a URL and BOS handles the rest.

![Marketplace with two registered sources](./docs/assets/marketplace/05-anthropic-added.png)

**Key features:**

- **Three item types** — install sandboxed **apps** (appear on the desktop instantly), **skills** (available to the assistant immediately), or **adopt spec templates** into your own Build Studio workflow.
- **Multi-format support** — BOS automatically detects the format when you add a URL. It supports BOS-native marketplaces (e.g. [vaaale/bos-marketplace](https://github.com/vaaale/bos-marketplace)), Anthropic agent-skills repos (e.g. [anthropics/skills](https://github.com/anthropics/skills)), and Claude Code skill repos (e.g. [ericgandrade/claude-superskills](https://github.com/ericgandrade/claude-superskills)). No manual configuration needed.
- **Search and filter** — a live filter narrows items across all registered marketplaces by name, description, or tag.
- **Installed badges** — items you've already installed are highlighted so you never lose track of what's in your OS.
- **Sync and remove** — pull the latest from any marketplace with one click, or remove a source entirely without affecting what you've already installed.

**To get started**, open the Marketplace app and add any of these URLs:

| Marketplace | URL |
|---|---|
| BOS Marketplace | `https://github.com/vaaale/bos-marketplace.git` |
| Anthropic Agent Skills | `https://github.com/anthropics/skills.git` |
| Claude Superskills | `https://github.com/ericgandrade/claude-superskills.git` |

→ **[Full tutorial: Using the Marketplace](docs/usage/tutorials/marketplace.md)**

---

## Marketplace

BOS has a built-in **Marketplace** app that lets you extend the OS with apps, assistant skills, and spec templates published in external git repositories. Just paste a URL and BOS handles the rest.

![Marketplace with two registered sources](./docs/assets/marketplace/05-anthropic-added.png)

**Key features:**

- **Three item types** — install sandboxed **apps** (appear on the desktop instantly), **skills** (available to the assistant immediately), or **adopt spec templates** into your own Build Studio workflow.
- **Multi-format support** — BOS automatically detects the format when you add a URL. It supports BOS-native marketplaces (e.g. [vaaale/bos-marketplace](https://github.com/vaaale/bos-marketplace)), Anthropic agent-skills repos (e.g. [anthropics/skills](https://github.com/anthropics/skills)), and Claude Code skill repos (e.g. [ericgandrade/claude-superskills](https://github.com/ericgandrade/claude-superskills)). No manual configuration needed.
- **Search and filter** — a live filter narrows items across all registered marketplaces by name, description, or tag.
- **Installed badges** — items you've already installed are highlighted so you never lose track of what's in your OS.
- **Sync and remove** — pull the latest from any marketplace with one click, or remove a source entirely without affecting what you've already installed.

**To get started**, open the Marketplace app and add any of these URLs:

| Marketplace | URL |
|---|---|
| BOS Marketplace | `https://github.com/vaaale/bos-marketplace.git` |
| Anthropic Agent Skills | `https://github.com/anthropics/skills.git` |
| Claude Superskills | `https://github.com/ericgandrade/claude-superskills.git` |

→ **[Full tutorial: Using the Marketplace](docs/usage/tutorials/marketplace.md)**

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
# Optional: seed a default API key so the wizard is pre-filled:
#   ANTHROPIC_API_KEY=sk-ant-...
```

No env vars are required — everything including the API key is configurable at runtime through the first-run wizard or **Settings → AI Provider**. Env vars are only a convenience to pre-seed the defaults.

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

On first launch a guided setup wizard walks you through:

1. **AI Provider** — which model powers the assistant (Anthropic / OpenAI / local), with a live model list
2. **Dev Harness** — the autonomous coder the assistant delegates to (Claude Code or OpenCode)
3. **Data Isolation** — how preview data is isolated from live data during self-modification
4. **Git Repos** — where your BOS source, spec store, and personal app repo live (sensible defaults, all editable)
5. **Marketplace** — which app marketplaces to add out of the box
6. A live progress screen while BOS provisions itself

Every step is optional — skip the wizard entirely and configure everything from **Settings** at any time.

---

## AI provider setup

![](docs/assets/BOS%20Welcome%20page.png)

BOS supports any OpenAI-compatible provider. Configure in **Settings → AI Provider** at runtime, or seed defaults in `.env.local`:

| Provider                   | Key to set |
|----------------------------|---|
| Anthropic                  | `ANTHROPIC_API_KEY=sk-ant-...` |
| OpenAI                     | Configure base URL and key in Settings |
| OpenAI Responses           | Configure base URL and key in Settings |
| Local (vLLM, Ollama, etc.) | `ANTHROPIC_BASE_URL=http://...` and `ANTHROPIC_API_KEY=local` |

---

## Docker Compose (multi-user)
**(Not stable yet)**

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

### 3. Create the network

`bos-net` is an external network so it is never recreated by compose (which would break running user containers). Create it once:

```bash
docker network create bos-net
```

### 4. Start

```bash
docker compose up -d
```

Visit **http://localhost** — you will be presented with a login page.

### 5. Create the first admin user

Generate a bcrypt hash inside the running bastion container, then write `users.yml`:

```bash
# Step 1: generate the hash (the bastion already has bcryptjs installed)
HASH=$(docker compose exec bastion node -e "const b=require('bcryptjs'); console.log(b.hashSync('changeme', 12))")

# Step 2: write users.yml into the bastion data volume
docker compose exec bastion sh -c "printf 'users:\n  admin:\n    passwordHash: %s\n    admin: true\n' '$HASH' > /data/users.yml"
```

Then log in at **http://localhost** with `admin` / `changeme` and change your password from the account page (`/app/account`).

### Auth providers

| Provider | Config |
|---|---|
| **Simple** (default) | Users defined in `/data/users.yml` inside bastion. Bcrypt passwords, hot-reloaded. |
| **Keycloak** | Set `AUTH_PROVIDER=keycloak` and `KEYCLOAK_*` vars. Use the Keycloak compose override. |

```bash
# Start with a local Keycloak (bundled bos realm pre-imported):
docker compose -f docker-compose.yml -f docker-compose.keycloak.yml up -d
```

See [docs/dev/deployment.md](docs/dev/deployment.md) for the full deployment guide including Keycloak setup, volume layout, and re-provisioning.

---

## Developer harness

For the AI assistant to write and preview code changes, it needs a developer harness — an autonomous coder it can delegate to. Pick either **Claude Code** or **OpenCode** in **Settings → Dev Harness**, then authenticate it however suits you: an interactive credential-file login, a plain API key, AWS Bedrock, Google Vertex AI, or (for Claude Code) a dedicated OAuth token via `claude setup-token` that won't conflict with your own local CLI session.

Claude Code, if you want it, installs with:

```bash
npm install -g @anthropic-ai/claude-code
```

Without a harness configured, everything else in BOS still works — you just lose self-modification.

---

## Documentation

![](docs/assets/BOS%20Docs.png)

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

---

## Contributing

BOS builds itself in the open — most new features start as a spec written in Build Studio, often by BOS's own assistant. Bug reports, feature specs, and pull requests are all welcome via GitHub Issues.

Licensed under [Attribution-NonCommercial 2.0](./LICENSE.md).
