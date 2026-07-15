# Quickstart — Local Development Mode

Run BrowserOS on your own machine in minutes. This mode gives you a single-user instance with hot-reload — ideal for trying out BOS, building apps, or developing features. No Docker required.

## Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| Node.js | 20 | [nodejs.org](https://nodejs.org) |
| Git | any | [git-scm.com](https://git-scm.com) |
| Anthropic API key | — | [console.anthropic.com](https://console.anthropic.com) |

## 1. Clone the repository

```bash
git clone https://github.com/your-org/browseros.git
cd browseros
```

## 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set your Anthropic API key:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

All other values have working defaults for local dev. The full variable reference is in `.env.example`.

## 3. Install dependencies

```bash
npm install
```

## 4. Start the development server

### Option A — Full experience (recommended)

The **Supervisor** manages the Next.js dev server and enables live version control and self-modification features:

```bash
npm run supervisor
```

BOS is now available at **[http://localhost:3000](http://localhost:3000)** (the Supervisor listens on port 8090 and starts Next.js on 3000).

### Option B — Plain Next.js dev server

If you only need the app without the Supervisor:

```bash
npm run dev
```

App available at **[http://localhost:3000](http://localhost:3000)**.

## 5. Complete the first-run wizard

On first visit BOS shows a short setup wizard. Walk through each step:

1. **AI Provider** — enter your Anthropic API key (or configure an OpenAI-compatible endpoint). The key is stored locally in `data/config/` and never sent anywhere except the provider's API.
2. **Dev Harness** (optional) — connects BOS to a Claude Code MCP harness for self-modification. Skip if you don't have one.
3. **Data Isolation** (optional) — configures sandboxed `run_command` execution. Skip for now.

After the wizard you land on the desktop.

## 6. Start using BrowserOS

| What | How |
|------|-----|
| Open the Assistant | Click the chat icon in the dock |
| Browse files | Click the Files icon in the dock |
| Open Settings | Click the gear icon in the dock |
| Change AI model | Settings → AI Provider |
| Install MCP servers | Settings → MCP |

## Updating

```bash
git pull
npm install          # picks up any new/changed dependencies
# restart npm run supervisor / npm run dev
```

## Next steps

- [Docker + SimpleAuth](./docker-simple-auth.md) — share BOS with a team
- [Docker + Keycloak](./docker-keycloak.md) — enterprise SSO
- [docs/usage/](../introduction.md) — end-user feature documentation
- [docs/usage/](../../dev/architecture-overview.md) — developer / extension guide
