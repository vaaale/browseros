# BrowserOS — Development & Architecture Guide

> Audience: the BOS assistant's **developer sub-agent** (Claude Code) and human contributors. Read this before implementing a new app or modifying a BOS feature. The canonical requirements live in `spec/bos.md`; this document explains **how BOS is actually built** so you can make good design choices.

---

## 1. What BOS is

A single‑page, **server‑side‑rendered** "operating system in the browser": a desktop shell with windows, a virtual file system, a web browser, and an agentic assistant (CopilotKit) that can operate and **extend BOS itself**. Everything persists as plain files under `./data`.

### Tech stack
- **Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind v4.**
- **Zustand** for client OS state (SSR‑safe factory + React context provider).
- **CopilotKit** (`@copilotkit/react-core`, `react-ui`, `runtime`) for the chat + tool/action system.
- **LLM SDKs**: `@anthropic-ai/sdk`, `openai`, `@ai-sdk/openai` + `ai`.
- **MCP**: `@modelcontextprotocol/sdk` (streamable‑HTTP, SSE, and **stdio** transports).
- **Claude Code** CLI for development tasks (headless `claude -p`).

### Golden rules (read these first)
1. **Server vs client.** Server‑only modules start with `import "server-only";` and may use Node (`fs`, `child_process`). Anything importing them must be a server component or route handler. Client components start with `"use client";`. `src/os/types.ts` is intentionally framework‑free and safe in both.
2. **The VFS is NOT the source tree.** `src/os/vfs.ts` is jailed to `data/vfs` — it is the *user's* sandboxed storage. It can never see or edit BOS's own code. To change BOS, edit files under `src/` (that's what *you*, the developer agent, do via your own tools — not via the VFS file tools).
3. **All development is done by Claude.** Building apps and modifying BOS are Claude tasks, never the local provider model. (See §9.)
4. **Minimize blast radius.** Modify BOS on a git **feature branch**, stage your changes, typecheck, and report. Don't touch secrets, `package.json`, lockfiles, or build config unless explicitly asked.
5. **Keep SSR and the first client render in sync.** The store is seeded from server props in `page.tsx`; don't introduce client‑only state that changes the initial markup.
6. **Update docs.** When you add/modify/remove an app or feature, update `data/docs` (the in‑OS hub) and, if architecture changed, `spec/bos.md` and this file.
7. **No premature abstraction, no dead code, minimal comments** (only explain non‑obvious "why").

---

## 2. Repository map

```
spec/bos.md                     Canonical requirements/design (keep in sync)
docs/USER_GUIDE.md              End-user documentation
docs/DEVELOPMENT.md             This file
.claude/agents/developer.md     Claude Code subagent definition (used in CLI mode)

src/
  app/                          Next.js App Router
    layout.tsx, page.tsx        Root layout; SSR entry — seeds the OS store
    apps/[...slug]/route.ts     Serves installed-app files from the VFS (/apps/<id>/…)
    api/**/route.ts             All server endpoints (see §13)
  os/                           Framework-free OS core
    types.ts                    AppManifest, OSSettings, WindowInstance, VfsEntry …
    apps.ts                     BUILTIN_APPS registry + getApp()
    vfs.ts                      Virtual file system (jailed to data/vfs)
    settings.ts                 OS settings (data/settings.json)
    wallpapers.ts               Wallpaper presets + wallpaperToCss()
  store/
    os-store.ts                 Zustand vanilla store: windows/apps/settings + actions
    os-provider.tsx             OSProvider, useOSStore(selector), useOSStoreApi()
  components/
    desktop/                    Shell: Desktop, WindowManager, Window, Dock, Topbar,
                                icons.tsx (name→lucide), FirstRunWizard
    apps/                       App components: FileBrowser, WebBrowser, ChatApp,
                                MemoryApp, DocsApp, SettingsApp, IframeApp, registry.tsx
      assistant/                Assistant sub-UI: ConversationPanel, InfoPanel, AgentSelector
      settings/                 Settings tabs: AppearanceTab, AppsTab, SkillsTab,
                                DevHarnessTab, AssistantTab, ConfigForm
    agent/                      CopilotKit wiring + assistant actions (*Actions.tsx),
                                CopilotProvider, ChatToolRenderer, ReasoningAssistantMessage,
                                MarkdownRenderers
  lib/
    os-client.ts                Client fetch helpers: fsClient, settingsClient
    net.ts                      fetchText(), isBlockedHost() (SSRF guard)
    mime.ts                     mimeForPath()
    proxy-path.ts, proxy-rewrite.ts   Web-browser proxy helpers
    config/                     Pluggable config system: types, store, registry
    apps/store.ts               Installed-app registry + lifecycle (install/uninstall/restore/purge)
    docs/store.ts               Documentation hub (data/docs)
    system/git.ts               Scoped git helper (branch/add/status)
    dev/repo-fs.ts              Repo-scoped source FS (jailed; for local dev sub-agents)
    dev/run-command.ts          Allowlisted command runner (typecheck/lint/build)
    mcp/                        MCP client (client.ts), server store (store.ts), types, ui
    devharness/harness-config.ts   Resolves how Claude Code runs (CLI vs MCP)
    agent/
      config.ts                 CORE_POLICY (always-on) + DEFAULT_PERSONALITY
      instructions.ts           composeInstructions(): policy + active agent personality + skills index
      provider.ts, provider-meta.ts   AI provider config + metadata; familyOf()
      llm.ts                    Provider-agnostic complete() + runToolLoop()
      openai-chat-adapter.ts    Forces OpenAI Chat Completions (not Responses)
      runtime.ts                CopilotRuntime options (wires MCP servers)
      tool-manifest.ts          Curated tool list shown in the Assistant's Tools panel
      conversations.ts          VFS-backed thread + message store (/Documents/Chats/<id>.json)
      card-collapse.ts          Event-card collapse store (timers OUTSIDE React)
      nested-events.ts          Encode/parse nested sub-agent event trees
      subagent-events.ts        Live delegation event store (keyed by task)
      skills/store.ts, improve.ts   Skill library (+ GEPA-lite improve)
      memory/store.ts, types.ts, reflect.ts   Long-term memory + reflection
      subagents/store.ts, types.ts, runner.ts, claude-runner.ts, tools.ts, markdown.ts
data/                           ALL runtime state (gitignored) — see §12
```

---

## 3. The OS shell & window manager

**Store** (`src/store/os-store.ts`, Zustand vanilla). State: `windows: WindowInstance[]`, `focusedId`, `zCounter`, `settings`, `apps: AppManifest[]`. Actions:

| Action | Purpose |
|---|---|
| `launch(appId, params?) → id\|null` | Open a window (focuses the existing one if the app is `singleton`). |
| `close(id)` / `minimize(id)` / `focus(id)` | Window lifecycle; `focus` bumps `zIndex`. |
| `move(id,x,y)` / `resize(id,bounds)` / `toggleMaximize(id)` | Geometry. |
| `setTitle(id,title)` | Rename a window. |
| `applySettings(patch)` | Update OS settings in the store (persist separately via `settingsClient`). |
| `registerApp(app)` / `unregisterApp(id)` | Add/remove an app at runtime (live desktop/dock refresh; `unregisterApp` also closes its windows). |

**SSR seeding** (`src/app/page.tsx`): server‑reads `getSettings()` + `listInstalledManifests()`, merges with `BUILTIN_APPS`, and passes them to `<OSProvider settings apps>`. Access state with `useOSStore(selector)`; for fresh reads in callbacks use `useOSStoreApi().getState()`.

**AppManifest** (`src/os/types.ts`): `id, name, icon (lucide name), defaultWidth, defaultHeight, singleton?, builtin?, kind?: "builtin"|"iframe", url?, source?`.

**How a window renders an app** (`src/components/desktop/Window.tsx`): if `manifest.kind === "iframe"` → `<IframeApp>` loads `manifest.url`; else it looks up a React component via `getAppComponent(appId)` from `src/components/apps/registry.tsx`. Built‑in apps are entries in that registry `Map`; runtime‑installed apps are iframes.

**Icons** (`src/components/desktop/icons.tsx`): `<AppIcon name=… />` maps a manifest's icon string to a lucide‑react component (with a fallback). Use a name that exists in that set. For installed apps, `pickIcon(name, spec)` in `src/lib/apps/store.ts` auto‑selects an icon by keyword (timer→`Timer`, calc→`Calculator`, note→`StickyNote`, …, default `Puzzle`).

**Desktop chrome** (`Desktop.tsx`, `Dock.tsx`, `Topbar.tsx`): only chrome opts out of text selection (`select-none`); **never** disable selection globally — app content must stay selectable.

---

## 4. The Virtual File System

`src/os/vfs.ts`, rooted at `data/vfs`, with `resolveSafe()` refusing path escapes. Exposes `list/stat/readText/readBuffer/writeText/writeBuffer/mkdir/remove/rename`. Seeds `Documents/Pictures/Desktop/Apps`. Reached from the client via `/api/fs` (+ `/api/fs/raw` for bytes) and the `fsClient` helpers in `src/lib/os-client.ts`. This is **user data**, not BOS source.

---

## 5. Apps subsystem

Apps are **versioned content in their own git repo (GitFS)**, not in `data/`. Root: `appsDir()` (`src/os/apps-dir.ts`) = `BOS_APPS_DIR` or `<cwd>/apps` (gitignored; a standalone repo via `src/lib/gitfs/store.ts`). See `spec/self-modification/gitfs.md`.

`src/lib/apps/store.ts` has **no central registry** — each app is a self-contained folder `<appsDir>/<id>/` holding its files plus an `app.json` manifest (`id, name, icon, createdAt, status: "installed"|"uninstalled", uninstalledAt?`). Apps are **discovered by listing** the apps dir. Served at `/apps/<id>/…` by `src/app/apps/[...slug]/route.ts` (reads the filesystem under a path-escape jail; injects `<base href="/apps/<id>/">` into HTML). `toManifest()` → iframe `AppManifest` (`url: /apps/<id>`).

Lifecycle (each step commits to GitFS): `installApp({name, icon?, files})` (writes `<id>/` + `app.json`), `uninstallApp(id)` (soft — `status:"uninstalled"`, **keeps files**), `restoreApp(id)`, `purgeApp(id)` (removes the folder). `listInstalledManifests()` returns only `installed` apps (desktop). API: `/api/apps` (GET list, POST install, DELETE uninstall/`?purge=1`, PATCH restore).

There is **no "Dev Studio" app and no `buildApp` tool**. Apps are created by delegating to the developer agent and then calling the `installApp` assistant action (the **Build App** skill).

---

## 6. Configuration system (Settings tabs are pluggable)

`src/lib/config/registry.ts` holds `REGISTRATIONS: ConfigRegistration[]`, each `{ schema, load, save }`:
- `schema: ConfigSchema` (`src/lib/config/types.ts`): `namespace, title, description?, order?, fields: ConfigField[], customComponent?`.
- `load()` returns current values; `save(patch)` persists.

`/api/config` GET returns all schemas with `values` (secret fields blanked) + `secretsSet`; PATCH `{namespace, values}` calls the registration's `save`. The same schema is **auto‑exposed to the assistant** as the `updateSetting`/`listConfigurableSettings` actions, so adding a tab also gives the agent a config tool — for free.

Rendering (`src/components/apps/SettingsApp.tsx`): a generic `<ConfigForm>` renders `fields`; if `schema.customComponent` is set, a custom React component is used instead (mapped in `CUSTOM_TABS`). Generic per‑namespace JSON is stored at `data/config/<namespace>.json` via `src/lib/config/store.ts` (`readNamespace`/`patchNamespace`); some namespaces (provider, appearance) delegate to their own stores instead.

Current tabs/namespaces: `assistant`, `skills`, `apps`, `appearance`, `ai-provider`, `dev-harness`, `browser-automation`.

---

## 7. The assistant subsystem (CopilotKit)

### Request flow
1. `src/components/agent/CopilotProvider.tsx` wraps the desktop in `<CopilotKit runtimeUrl="/api/copilotkit" threadId={activeConversationId}>` and mounts all `*Actions` components (which register tools). Switching conversation switches `threadId`, remounting the chat.
2. `src/app/api/copilotkit/route.ts` builds the runtime + adapter **per request** (so Settings changes apply with no restart):
   - **Anthropic family** → `AnthropicAdapter` (prompt caching on, `maxInputTokens` from config).
   - **OpenAI family** → `OpenAIChatAdapter` pointed at the in‑app proxy `${origin}/api/llm/openai` (keeps the real key server‑side).
3. `src/lib/agent/runtime.ts` (`buildRuntimeOptions`) wires configured MCP servers so their tools are auto‑exposed to the agent.
4. `src/app/api/llm/openai/[...path]/route.ts` normalizes OpenAI‑compatible calls: forces **Chat Completions** (not Responses), injects `max_tokens`, and surfaces `reasoning_content` as `<think>…</think>` so reasoning models stream content.

### System instructions
`src/lib/agent/instructions.ts` `composeInstructions()` = **CORE_POLICY** (`src/lib/agent/config.ts`, always‑on rules: delegation, Claude‑for‑dev, build‑vs‑modify, feature‑branch, docs, self‑improvement, VFS‑is‑not‑source) + the active **agent**'s personality + a **skills index** (name + when‑to‑use; full body loaded on demand via `loadSkill`). The composed text is what `ChatApp` passes to `<CopilotChat instructions>`.

### Actions (tools)
Each `src/components/agent/*Actions.tsx` registers tools with `useCopilotAction({ name, description, parameters, handler })`. Handlers call BOS APIs. `ChatToolRenderer` registers a wildcard action (`name: "*"`) to render every tool call as a card.

| Component | Actions |
|---|---|
| `OSActions` | `launchApp, listApps, closeWindow, changeWallpaper, openWebPage, listFiles, readFile, writeFile, createFolder, deletePath` |
| `McpActions` | `listMcpServers, addMcpServer, removeMcpServer, probeMcpServer` |
| `SubAgentActions` | `listSubAgents, createSubAgent, delegateToSubAgent, requestClaudeAgentPermission` (elicitation card) |
| `MemoryActions` | `rememberThis, recallMemories` |
| `DevActions` | `installApp, listInstalledApps, uninstallApp, getMyInstructions, updateMyInstructions` |
| `ConfigActions` | `listConfigurableSettings, updateSetting` |
| `AssistantActions` | `switchAssistantAgent` |
| `SkillsActions` | `loadSkill, saveSkill` |
| `SelfImprovementActions` | `reflectAndLearn, improveSkill` |
| `DocsActions` | `listDocs, readDoc, writeDoc` |
| `GitActions` | `gitStatus, startFeatureBranch, stageChanges` |
| `WorkflowActions` | `createWorkflow, modifyWorkflow, runWorkflow, getStatus, cancelWorkflow, exportWorkflow, validateWorkflow` |

The Tools panel in the chat is a curated mirror in `src/lib/agent/tool-manifest.ts` — **keep it in sync** when you add/remove an action.

### Event rendering
- `ReasoningAssistantMessage.tsx` parses `<think>…</think>` into a reasoning disclosure and always renders the default assistant message (so tool/subComponent UI shows).
- `ChatToolRenderer.tsx` renders each tool call as a collapsible **native `<details>`** card; renders live delegation events, nested sub‑agent trees, and MCP‑UI iframes.
- `card-collapse.ts` is a **module‑level store with timers that live OUTSIDE the React lifecycle** — the chat remounts cards while streaming, so a per‑component timer would be cleared and never fire. Use `markComplete(id)` (auto‑collapse) / `useCollapsed(id)`.
- `subagent-events.ts` is a live store keyed by task; `/api/subagents/delegate` streams **NDJSON** (`{type:"tool"}` per event, then `{type:"done"|"error"}`) so sub‑agent activity appears live, not at the end.
- `nested-events.ts` encodes/parses a `BOS-NESTED` marker for post‑hoc nested rendering.
- `MarkdownRenderers.tsx` renders fenced ```html as a sandboxed iframe preview.

---

## 8. Personality (agents), Skills, Memory, Self‑improvement

- **Personality (active agent)**: there is no separate "profile". The main assistant's personality is whichever **agent** is active; `composeInstructions()` uses its system prompt. The active agent id lives in the `assistant` config namespace (`activeAgent`, default `assistant`); helpers `getActiveAgentId` / `setActiveAgentId` / `getActiveAgentBody` / `setAgentSystemPrompt` live in `agent/subagents/store.ts`. The seeded **Assistant** agent (`data/agents/assistant/AGENT.md`) is the default. Managed in **Settings → Assistant** and switchable via the `switchAssistantAgent` action.
- **Skills** (`agent/skills/store.ts`): a skill is either a flat `data/skills/<id>.md` or a directory `data/skills/<id>/` with `SKILL.md` + optional `scripts/` and `references/` (asset files; names sanitized via `safeAssetName`). Frontmatter: `name, description, when_to_use, score`. Editable end‑to‑end in **Settings → Skills** (`SkillsTab.tsx`: list → detail editor for the main file + scripts + references). API `/api/skills` (GET list, GET `?id=`, POST save w/ `previousId` for rename, DELETE). The seeded **Develop in BrowserOS** skill (a `SKILL.md` plus `references/`) covers building apps and modifying BOS.
- **Memory** (`agent/memory/store.ts`): `data/memory/memories.json`. Records `{id,type,content,tags,createdAt,usefulness}`. `recall(query)` scores by keyword overlap (tags ×3, content ×2) + recency + usefulness, and reinforces recalled/added memories. Surfaced in the Memory app and the `rememberThis`/`recallMemories` actions.
- **Self‑improvement**: `reflectAndLearn` (`/api/assistant/reflect` → `memory/reflect.ts`) records durable memories and may propose a skill; `improveSkill` (`/api/skills/improve` → `skills/improve.ts`) is a GEPA‑lite optimizer that rewrites a skill from feedback and tracks a `score`.

---

## 9. Sub‑agents & how Claude Code runs (CRITICAL for dev tasks)

**Definitions** (`agent/subagents/`): a sub‑agent is `data/agents/<id>/AGENT.md` (frontmatter `type: local|claude`, optional `subagent_type`, `tools`, `model`; body = system prompt). Seeded: **Assistant** (the default main-chat personality), Researcher, File Organizer, Writer, Planner (local), **Developer** (claude). The main assistant's personality is the active agent (see §8) — these are one and the same set. Ephemeral agents run without being persisted.

**Routing** (`runner.ts` `runSubAgent`):
- `type: "local"` → `runToolLoop` (`llm.ts`) with the configured provider and the agent's tools. Default step budget is small (`MAX_STEPS = 8`); agents holding repo‑scoped tools get `DEV_MAX_STEPS = 40`.
- `type: "claude"` → `runClaudeAgent` (`claude-runner.ts`). **No local fallback** — development is Claude‑only by design.

**How Claude Code runs** is chosen in Settings → Dev Harness (`devharness/harness-config.ts` → `{ mode: "cli", cwd } | { mode: "mcp", server }`):
- **`cli` (default & recommended):** spawns `claude -p <task> --append-system-prompt <agent prompt> --output-format stream-json --verbose --dangerously-skip-permissions` with `cwd = repo`. Claude is the autonomous coder using its own Read/Edit/Write/Bash. BOS parses the stream‑json (`type:"assistant"`→`content[].tool_use` for live events; `type:"result"`→`result`/`is_error`). Skips permission prompts for non‑interactive use → **intended to run sandboxed (e.g. Docker)**.
- **`mcp`:** connects to a Claude Code MCP server (local stdio `claude mcp serve`, or remote HTTP/SSE) and drives its `Agent` tool with a generated `subagent_type`. ⚠️ The `Agent` tool only spawns a sub‑agent whose type was **registered at the harness's startup**; `claude mcp serve` here exposes **no** spawnable agents, so the CLI path is preferred. Errors are tagged `HARNESS_UNAVAILABLE`.

**Repo‑scoped tooling for local sub‑agents** (`agent/subagents/tools.ts`, gated — opt‑in via the agent's `tools`):
- `read_source/list_source/search_source/write_source/edit_source` via `lib/dev/repo-fs.ts` — **jailed to the repo root**; reads deny `.env*`/`.git`/`node_modules`/`.next`; **writes allowed only under `src/`, `spec/`, `public/`, `docs/`, `data/`**.
- `run_command` via `lib/dev/run-command.ts` — fixed allowlist (`typecheck`→`npx tsc --noEmit`, `lint`→`npx eslint .`, `build`→`npm run build`), `execFile` (no shell).
- `git_branch/git_stage/git_status` via `lib/system/git.ts`.
The default tool set (`SUBAGENT_TOOLS`) is **VFS‑only**; dev tools are never handed out implicitly.

> If you're the Developer agent in CLI mode, you use your *own* Claude Code tools (Read/Edit/Write/Bash/Grep), not these BOS tools. The repo‑fs tools exist for the local‑agent fallback path.

---

## 10. MCP

- **Chat MCP servers**: `lib/mcp/store.ts` (`data/mcp-servers.json`, or `BOS_MCP_SERVERS` env). `lib/mcp/client.ts` `createBosMcpClient(cfg)` returns a CopilotKit‑compatible client; resilient (no tools if unreachable). Transports: `http` (streamable), `sse`, `stdio` (spawns a command, `cwd`/`env`). `extractText()` also surfaces MCP‑UI HTML resources (`lib/mcp/ui.ts`). Managed via `/api/mcp` and `McpActions`.
- **Dev harness**: separate from chat MCP servers; see §9. `connectMcpClient()` + `extractText()` are exported for the harness runner.

---

## 11. Web browser proxy

`/api/proxy/[[...path]]/route.ts` is a **same‑origin, path‑based** rewriting proxy (`/api/proxy/<scheme>/<host>/<path>`). It rewrites HTML (`src`/`href`/`action`/`poster`) and CSS (`url()`/`@import`), strips CSP/`<base>`, and injects a runtime shim re‑routing `fetch`/XHR (`lib/proxy-rewrite.ts`, `lib/proxy-path.ts`). `next.config.ts` sets `skipTrailingSlashRedirect: true` (a slash‑stripping redirect breaks relative‑URL resolution / ES‑module imports). `lib/net.ts` `isBlockedHost()` guards SSRF. Out of scope: DRM/streaming, WebSockets.

---

## 12. Data layout (`./data`, gitignored)

| Path | Contents |
|---|---|
| `data/vfs/` | User VFS (Documents, Pictures, Desktop). Chat history at `data/vfs/Documents/Chats/<id>.json`. |
| `data/settings.json` | OS settings (wallpaper, accent, theme). |
| `data/config/<ns>.json` | Generic per‑namespace config (e.g. `dev-harness`). |
| `apps/<id>/` (`BOS_APPS_DIR`) | Installed apps — a standalone git repo (GitFS), `index.html` + `app.json` per app. Not under `data/`. |
| `data/mcp-servers.json` | Chat MCP servers. |
| `data/memory/memories.json` | Long‑term memory. |
| `data/skills/<id>.md` or `data/skills/<id>/SKILL.md` (+ `scripts/`, `references/`) | Skill library. |
| `data/agents/<id>/AGENT.md` | Agent definitions — delegatable sub‑agents AND the assistant's personality agents (incl. the default `assistant`). |
| `data/docs/<id>.md` | In‑OS documentation hub. |

The AI provider config (incl. the API key) persists via the provider store and is **masked** in API responses — never echo a key to the client.

---

## 13. API routes

| Path | Methods | Purpose |
|---|---|---|
| `/api/fs` | GET (`op=list\|read`), POST (`op=write\|mkdir\|delete\|rename`) | VFS operations |
| `/api/fs/raw` | GET `?path=` | Raw file bytes (images, etc.) |
| `/api/settings` | GET, PATCH | Read / update OS settings |
| `/api/config` | GET, PATCH | Config schemas+values (secrets masked) / save |
| `/api/copilotkit` | POST | CopilotKit runtime endpoint (per‑request adapter) |
| `/api/llm/openai/[...path]` | POST (proxy) | OpenAI normalization proxy |
| `/api/agent/provider` | GET, PATCH | AI provider config (key masked) |
| `/api/agent/provider/test` | POST | Test provider connection |
| `/api/mcp` | GET, POST, DELETE (+ `?probe=`) | Chat MCP servers + probe |
| `/api/memory` | GET, POST, DELETE | Memory CRUD |
| `/api/skills` | GET (list / `?id=`), POST, DELETE | Skill CRUD (+ scripts/references) |
| `/api/skills/improve` | POST | GEPA‑lite skill improvement |
| `/api/assistant/agent` | GET, PATCH, POST | Agents + composed instructions / set active agent / create agent |
| `/api/assistant/reflect` | POST | Reflection → memories/skills |
| `/api/subagents` | GET, POST, DELETE | Sub‑agent registry |
| `/api/subagents/delegate` | POST (NDJSON stream) | Run a sub‑agent, stream events |
| `/api/apps` | GET, POST, DELETE (`?purge=1`), PATCH | Install / uninstall / purge / restore apps |
| `/api/docs` | GET, POST, DELETE | Documentation hub |
| `/api/system/git` | GET, POST | Branch / stage / status (repo) |
| `/api/system/setup` | GET, POST | First‑run flag |
| `/api/dev-harness` | GET | Probe the configured harness (CLI version or MCP tools) |
| `/api/proxy/[[...path]]` | GET | Web‑browser proxy |
| `/api/workflows` | GET, POST, DELETE, PATCH | Workflow CRUD (+ merge‑patch) |
| `/api/workflows/validate` | POST | Validate a workflow's DAG, agents, and dependencies |
| `/api/workflows/run` | POST (NDJSON stream) | Execute a workflow, stream step events |
| `/api/workflows/cancel` | POST | Cancel a running workflow |
| `/api/workflows/status` | GET | Read current execution state + per‑step status |
| `/api/workflows/generate` | POST | Generate a workflow JSON from a task description |

---

## 14. Extension recipes

### Add a built‑in app
1. Create `src/components/apps/MyApp.tsx` (`"use client"`, props `{ windowId, appId, params }` from `AppProps`). Keep content text‑selectable.
2. Register it in `src/components/apps/registry.tsx` (`["myapp", MyApp]`).
3. Add an `AppManifest` to `BUILTIN_APPS` in `src/os/apps.ts` (`id:"myapp"`, a valid `icon` from `icons.tsx`, sizes, `singleton?`). It then appears on the desktop/dock (SSR seed) and is launchable via `launchApp`.
4. If it needs persistence, add a server store under `src/lib/...` (`import "server-only"`, write under `data/…`) + an `/api/...` route; call it from the client with `fetch`.
5. Update `data/docs` and, if relevant, `tool-manifest.ts`.

### Add a Settings tab
1. Add a `ConfigRegistration` to `REGISTRATIONS` in `src/lib/config/registry.ts` (`schema.namespace`, `title`, `order`, `fields` and/or `customComponent`; `load`/`save`). For simple key/values, `save` can use `patchNamespace(ns, patch)`.
2. For a custom UI, create `src/components/apps/settings/MyTab.tsx` and map it in `CUSTOM_TABS` in `SettingsApp.tsx` by the `customComponent` key.
3. The fields are auto‑exposed to the assistant via `updateSetting` — no extra work.

### Add an assistant tool/action
1. Add a `useCopilotAction({...})` in the most relevant `src/components/agent/*Actions.tsx` (or a new component mounted in `CopilotProvider.tsx`). The handler runs client‑side; hit a BOS `/api/...` route for server work.
2. Mirror it in `src/lib/agent/tool-manifest.ts` (Tools panel).
3. Prefer extending an existing grouping over creating new components.

### Add / seed a skill
- Runtime: `saveSkill` action or Settings → Skills. From‑scratch default: add to the `SEED` array in `agent/skills/store.ts` (seeds only when `data/skills` is empty). For scripts/references, save via the `/api/skills` POST shape (`scripts`/`references` arrays) or the directory layout.

### Add a sub‑agent
- `createSubAgent` action, or add to `DEFAULTS` in `agent/subagents/store.ts`. Use `type:"claude"` for coding agents; give local dev agents the repo‑scoped `tools` ids if they should edit source.

### Modify an existing built‑in feature (e.g. a Settings page)
1. `git checkout -b bos/<short-name>`.
2. Find the files (UI under `src/components/...`, server logic under `src/lib/...`, routes under `src/app/api/...`). The Skills page is `src/components/apps/settings/SkillsTab.tsx` + `src/lib/agent/skills/store.ts` + `src/app/api/skills/route.ts`.
3. Make focused edits; `src/` hot‑reloads under `next dev`.
4. `npx tsc --noEmit` and `npm run lint`; fix what you broke.
5. `git add -- <files>`; report what changed and how to test. Update docs.

---

## 15. Design heuristics (make good choices)

- **Built‑in app vs installed app?** Built‑in = a first‑class React app in the repo (registry + `BUILTIN_APPS`), for OS features. Installed app = a self‑contained `index.html` served as an iframe, for user‑requested utilities. Don't make a built‑in app when a generated standalone app suffices.
- **Where does state live?** Ephemeral window/UI state → the Zustand store. User data → the VFS. Durable feature/app config → a config namespace (gets a Settings tab + an assistant tool for free). Agent knowledge → memory/skills. Never invent a new persistence path when one of these fits.
- **Local vs Claude sub‑agent.** Any code change → Claude. Research/writing/file‑tidying → local. Don't route coding to the local model.
- **Adding config?** If a value should be user‑editable, add a config namespace rather than hardcoding — you get UI + an assistant tool automatically.
- **Server boundary.** Put Node/`fs`/secrets in `server-only` modules behind `/api` routes; clients talk over `fetch`. Don't import server stores into client components.
- **Token budgets.** Never hardcode small `max_tokens`; use the configured budget (reasoning models need room — see §16).
- **Match scope.** A bug fix doesn't need a refactor; a one‑off doesn't need an abstraction. Three similar lines beat a premature helper.

---

## 16. Gotchas & hard‑won lessons

- **VFS ≠ source.** The file tools (`listFiles/readFile/writeFile`) and the file browser only see `data/vfs`. To change BOS, edit `src/`. Don't hunt for BOS code in the VFS.
- **Reasoning models.** They spend output tokens on hidden reasoning before content. Use a large configured `max_tokens`; route OpenAI‑compatible chat through the proxy (Chat Completions, not Responses) and surface `reasoning_content` as `<think>` — already handled in `/api/llm/openai` + `openai-chat-adapter.ts`.
- **Event‑card timers must live outside React** (`card-collapse.ts`) — the chat remounts cards while streaming.
- **Sub‑agent events must stream** via NDJSON (`/api/subagents/delegate`), not be batched at the end.
- **MCP `isError`.** Treat a tool result's `isError` as a real error (don't return its text as success) — see `claude-runner.ts`.
- **`claude mcp serve` ≠ Claude doing the work.** It exposes Claude's *tools* to a client; the brain is the client's model. To have Claude itself code, use headless `claude -p` (the default `cli` mode). The serve‑mode `Agent` tool needs registered agent types and spawns nothing here.
- **Don't run `next build` against a live `next dev`** — they share `.next` and it can kill the dev server. After deleting/adding a route, stale `.next/types` can cause phantom `tsc` errors until a rebuild.
- **Text selection**: only chrome gets `select-none`.
- **Web proxy**: keep it path‑based and keep `skipTrailingSlashRedirect: true`.

---

## 17. Build & verify

```bash
npm run dev          # next dev (Turbopack), http://localhost:3000 — src/ hot-reloads
npx tsc --noEmit     # type check
npm run lint         # eslint
npm run build        # production build (regenerates .next/types) — NOT while dev is running
npm run test:e2e     # Playwright e2e (reuses a running dev server, else starts one)
```

Always typecheck after editing. For UI changes, verify in the browser when possible; if you can't, say so explicitly rather than claiming success.

---

## 18. Testing & browser automation (Playwright)

BOS uses Playwright for two distinct purposes (specs: `spec/self-modification/testing.md`, `spec/automation/browser-automation.md`):

- **Self-testing (e2e).** `playwright.config.ts` + the `e2e/` suite. Tests run against the app on `http://localhost:3000` (`reuseExistingServer` reuses a running `npm run dev`, else Playwright starts one). `e2e/global-setup.ts` marks setup complete so the first-run wizard stays closed; `e2e/fixtures.ts` provides a ready desktop. Stable hooks added to the shell: `data-testid="desktop" | "dock" | "dock-<appId>" | "window-<appId>"`. Keep tests deterministic and **stub/avoid the LLM** (assert the chat UI mounts, not model output). Run with `npm run test:e2e` (or the `e2e` entry in `lib/dev/run-command.ts`). The developer agent MUST author tests + fixtures for any BOS change (the "Develop in BrowserOS" skill encodes this).
- **Browser automation (assistant tool).** **Settings → Browser Automation** (`browser-automation` namespace, off by default) configures a *managed* Playwright MCP server. `lib/automation/playwright-mcp.ts` derives an `McpServerConfig` from that config (host scope via `--allowed-origins`/`--blocked-origins`, `--headless`, `--isolated`, plus `--executable-path` pointing at the installed Chromium resolved by the probe — so it reuses the e2e browser with no extra download) and `lib/agent/runtime.ts` appends it to the agent's MCP servers, so its browser tools are auto-exposed. Deny-by-default host scope; sandboxed; bypasses the in-app proxy's SSRF guard, so only allowed origins are reachable.
- **Capability probe.** `lib/playwright/probe.ts` (`detectPlaywright()`) checks for a Chromium build and the `@playwright/test` / `@playwright/mcp` packages; both features **degrade gracefully** when no browser is present (e2e is skippable; automation simply exposes no tools).

One-time environment setup: `npm install -D @playwright/test @playwright/mcp` then `npx playwright install chromium` (run the browser install as your normal user; `sudo npx playwright install-deps chromium` for system libraries).
