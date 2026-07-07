# BrowserOS — Architecture Overview

> **Audience:** the BOS assistant's **developer sub‑agent** (Claude Code) and human
> contributors. Read this before implementing a new app or modifying a BOS feature.
> The canonical *requirements* live in `specs/`; this tree documents **how BOS is
> actually built** (code is the source of truth — where code and spec disagree, see
> `specs/discrepancies.md`).

---

## 1. What BOS is

A single‑page, **server‑side‑rendered** "operating system in the browser": a
desktop shell with windows, a virtual file system, a web browser, and an agentic
assistant (CopilotKit) that can operate and **extend BOS itself**. All runtime
state persists as plain files under `./data`; installed apps are versioned content
under `./apps`.

### Tech stack

- **Next.js 16** (App Router, Turbopack), **React 19**, **TypeScript**, **Tailwind v4**.
- **Zustand** for client OS state (SSR‑safe vanilla store + React context provider).
- **CopilotKit** (`@copilotkit/react-core`, `react-ui`, `runtime`) for the chat +
  tool/action system.
- **LLM SDKs**: `@anthropic-ai/sdk`, `openai`.
- **MCP**: `@modelcontextprotocol/sdk` (streamable‑HTTP, SSE, and **stdio** transports).
- **esbuild** for bundling installed app projects.
- **Claude Code** CLI for development tasks (headless `claude -p`); **OpenCode** CLI
  (`opencode run`) is a provider‑agnostic alternative dev‑harness backend.
- **Playwright** for e2e self‑testing and (optionally) browser automation.

---

## 2. Golden rules (read first)

1. **Server vs. client.** Server‑only modules begin with `import "server-only";` and
   may use Node (`fs`, `child_process`). Anything importing them must be a server
   component or route handler. Client components begin with `"use client";`.
   `src/os/types.ts` is intentionally framework‑free and safe in both.
2. **The VFS is NOT the source tree.** `src/os/vfs.ts` is jailed to `data/vfs` — it
   is the *user's* sandbox. It can never see or edit BOS's own code. To change BOS,
   edit files under `src/` (that's what the developer agent does with its **own**
   tools — not via the VFS file tools).
3. **All development is done by Claude.** Building apps and modifying BOS are Claude
   sub‑agent tasks, never the local provider model. See
   [Sub‑agents & delegation](assistant/sub-agents-and-delegation.md).
4. **Minimize blast radius.** Modify BOS on a git **feature branch**, stage changes,
   typecheck, and report. Don't touch secrets, `package.json`, lockfiles, or build
   config unless explicitly asked.
5. **Keep SSR and the first client render in sync.** The store is seeded from server
   props in `src/app/page.tsx`; don't introduce client‑only state that changes the
   initial markup (hydration mismatches).
6. **Update docs.** When you add/modify/remove an app or feature, update the
   relevant page under `docs/usage` + `docs/dev` (the source trees the in‑OS Docs
   app serves) and the matching `specs/` file if the architecture changed.
7. **No premature abstraction, no dead code, minimal comments** (only explain
   non‑obvious "why").

---

## 3. The three storage layers

BOS deliberately separates three kinds of state. Don't conflate them:

| Layer | What | Where | Versioning |
|---|---|---|---|
| **BOS source** | The Next.js app itself | the BOS git repo (`src/`, …) | git + Supervisor worktrees (live version control) |
| **Runtime state** (DataFS) | settings, memory, skills, agents, docs, MCP list, VFS, chats, provider config | `./data` (`BOS_DATA_DIR`) | none — latest value wins; preview clones for isolation |
| **Versioned content** (GitFS) | installed apps (workflows later) | `./apps` (`BOS_APPS_DIR`) | its **own** standalone git repo (history/branch/marketplace) |

See [Repository & data layout](repository-and-data-layout.md),
[Installed apps](apps/installed-apps.md),
[DataFS](self-modification/data-isolation-datafs.md).

---

## 4. Request lifecycle (high level)

1. `src/app/page.tsx` (dynamic SSR) reads `getSettings()` + `listInstalledManifests()`,
   merges with `BUILTIN_APPS`, and seeds `<OSProvider>`. It wraps the desktop in
   `<CopilotProvider>` and renders `<Desktop>`.
2. The **Zustand** store (`src/store/os-store.ts`) holds windows/apps/settings on
   the client. Apps render in windows (built‑in React component or installed‑app
   iframe).
3. The chat (`src/apps/chat`) mounts `<CopilotChat>`; CopilotKit posts to
   `/api/copilotkit`, which builds the runtime + provider adapter **per request**
   (so Settings changes apply with no restart) and wires MCP servers.
4. Assistant **actions** (client `useCopilotAction`) call BOS `/api/**` routes for
   server work; **sub‑agent delegation** streams events over NDJSON.

---

## 5. Map of this documentation

- **[Repository & data layout](repository-and-data-layout.md)** — directory map, `data/`, `apps/`, env vars.
- **OS shell** — [window manager & store](os-shell/window-manager-and-store.md), [VFS](os-shell/virtual-file-system.md), [settings & wallpaper](os-shell/settings-and-wallpaper.md).
- **[Configuration system](configuration/configuration-system.md)** — pluggable Settings tabs = assistant tools.
- **Apps** — [built‑in](apps/built-in-apps.md), [installed (GitFS)](apps/installed-apps.md).
- **Assistant** — [overview](assistant/overview.md), [actions & tools](assistant/actions-and-tools.md), [sub‑agents](assistant/sub-agents-and-delegation.md), [API](assistant/api/assistant-api.md).
- **[Memory](memory/memory.md)**, **[Self‑improvement](self-improvement/self-improvement.md)**.
- **[MCP](mcp/mcp.md)**, **[Browser automation](automation/browser-automation.md)**, **[Web proxy](web-proxy/web-proxy.md)**.
- **Self‑modification** — [live version control](self-modification/live-version-control.md), [DataFS](self-modification/data-isolation-datafs.md), [testing](self-modification/testing.md).
- **[Workflows](workflows/workflows.md)**.
- **[API reference](api-reference.md)**, **[Extending BOS](extending-bos.md)**, **[Design heuristics & gotchas](design-heuristics.md)**, **[UI style guide](style-guide/README.md)**.

---

## 6. Build & verify

```bash
npm run dev          # next dev (Turbopack), http://localhost:3000 — src/ hot-reloads
npx tsc --noEmit     # type check
npm run lint         # eslint
npm run build        # production build — do NOT run while next dev is live (shared .next)
npm run test:e2e     # Playwright e2e (reuses a running dev server, else starts one)
npm run supervisor   # run under the Supervisor (live version control)
```

`tools/gen-apps.mjs` runs automatically on `predev`/`prebuild` (or `npm run
gen:apps`) to discover built‑in apps. Always typecheck after editing. For UI
changes, verify in the browser when possible; if you can't, say so rather than
claiming success.

---

## Multi-user Docker deployment (bastion / 024-docker-multiuser)

For multi-user production deployments BOS uses a **bastion** service (`bastion/`) that sits in front of per-user BOS containers:

```
Browser ──► bastion:80
              ├─ /app/login, /app/admin, /app/account  →  Vite SPA (served by bastion)
              ├─ /login, /logout, /auth/*               →  auth routes (Express)
              ├─ /admin/*                               →  admin API (Express, admin only)
              ├─ /account/*                             →  self-service API (Express)
              └─ /**  (authenticated catch-all)         →  proxy → bos-{username}:8090
```

### Per-user isolation

Each user gets their own Docker container `bos-{username}` on the `bos-net` bridge network. The bastion reaches it by Docker DNS name — no host port mapping needed. Three volumes per user:

| Mount | Type | Path in container |
|---|---|---|
| `VOLUME_BASE/{username}/src` | bind | `/app/src` |
| `VOLUME_BASE/{username}/data` | bind | `/app/data` (→ `BOS_DATA_DIR`) |
| `bos-nm-{username}` | named volume | `/app/node_modules` |

### Bastion source layout

```
bastion/
  src/
    config.ts      ← typed config from env + /data/config.json
    sessions.ts    ← JWT HTTP-only cookie (issue/verify/clear)
    docker.ts      ← dockerode wrapper (no shell docker)
    lifecycle.ts   ← per-user state machine, idle timers, startup reconciliation
    provision.ts   ← git clone + volume + container; 5 re-provision ops
    proxy.ts       ← session-gated catch-all proxy, WS support
    auth/          ← simple (bcrypt YAML, hot-reload) + keycloak (OIDC)
    routers/       ← auth, admin, account Express routers
  ui/              ← Vite + React SPA (Login, Admin, Account pages)
  Dockerfile       ← 3-stage: ui-build → ts-build → runtime
```

See `docs/dev/deployment.md` for the full deployment guide.
