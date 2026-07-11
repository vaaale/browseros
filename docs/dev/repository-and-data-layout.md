# Repository & data layout

## Repository map

```
seed/spec-store/                 Shipped bundle that seeds the system spec store (018)
.specify/templates/              spec-kit ENGINE (templates + command prompts) — stays in source
/specs  (BOS_SPECS_ROOT)         External spec stores — GITIGNORED, not tracked; seeded at runtime:
  bos-system-specs/              BOS-owned system store (own git repo + spec-store.json);
                                 holds NNN-feature specs, overview.md, discrepancies.md,
                                 and .specify/memory/constitution.md
  user-specs/                    User-owned store (own git repo)
docs/
  usage/                        End-user documentation (this guide's user half)
  dev/                          Developer/agent documentation (this tree)
CLAUDE.md                       Orientation for the developer agent
tools/
  gen-apps.mjs                  Built-in app discovery (writes src/apps/_*.generated.ts)
  supervisor/supervisor.mjs     The Supervisor control plane (live version control)

src/
  app/                          Next.js App Router
    layout.tsx, page.tsx        Root layout; SSR entry — seeds the OS store
    apps/[...slug]/route.ts     Serves installed-app files from GitFS (/apps/<id>/…)
    api/**/route.ts             All server endpoints (see api-reference.md)
  apps/                         Built-in apps — one self-describing folder each:
    <id>/manifest.ts            App metadata (AppManifest; folder name = id)
    <id>/index.tsx              Entry component (default export; "use client")
    _*.generated.ts             Auto-discovery output (gitignored; tools/gen-apps.mjs)
  os/                           Framework-free OS core
    types.ts                    AppManifest, OSSettings, WindowInstance, VfsEntry …
    apps.ts                     BUILTIN_APPS (sorted) + getApp()
    apps-dir.ts                 appsDir(): BOS_APPS_DIR or <cwd>/apps  (GitFS root)
    data-dir.ts                 dataDir(): BOS_DATA_DIR or <cwd>/data  (runtime state)
    atomic-write.ts             writeFileAtomic() (temp + rename)
    vfs.ts                      Virtual file system (jailed to data/vfs)
    settings.ts                 OS settings (data/settings.json)
    wallpapers.ts               Wallpaper presets + wallpaperToCss()
  store/
    os-store.ts                 Zustand vanilla store: windows/apps/settings + actions
    os-provider.tsx             OSProvider, useOSStore(selector), useOSStoreApi()
  components/
    desktop/                    Desktop, WindowManager, Window, Dock, Topbar,
                                VersionControls, FirstRunWizard, icons.tsx
    apps/                       Shared app UI: registry.tsx, IframeApp, ProviderSettings,
      assistant/                ConversationPanel, InfoPanel, AgentSelector
      settings/                 AppearanceTab, AppsTab, SkillsTab, AssistantTab,
                                DevHarnessTab, DataFsTab, VersionsTab, ConfigForm
    agent/                      CopilotKit wiring + *Actions.tsx + renderers
  lib/
    os-client.ts                Client fetch helpers: fsClient, settingsClient
    net.ts                      fetchText(), isBlockedHost() (SSRF guard)
    mime.ts, proxy-path.ts, proxy-rewrite.ts   Web-browser proxy helpers
    config/                     Pluggable config system: types, registry, store
    apps/                       store.ts (install/uninstall/restore/purge), build.ts (esbuild)
    gitfs/store.ts              Thin git layer for the content repo
    datafs/                     clone.ts (preview clone backends), probe.ts (fs capabilities)
    devharness/                 harness-config.ts (cli: claude|opencode, or mcp),
                                supervisor.ts (client)
    docs/store.ts               Read-only reader of the project docs/ trees (usage + dev)
    system/git.ts               Scoped git helper (branch/add/status)
    dev/repo-fs.ts              Repo-scoped source FS (jailed; local dev sub-agents)
    dev/run-command.ts          Allowlisted command runner (typecheck/lint/build)
    mcp/                        client.ts, store.ts, types.ts, ui.ts
    automation/playwright-mcp.ts   Managed Playwright MCP server config
    playwright/probe.ts         Shared "is a browser available?" probe
    workflows/                  types, store, runner, validate, generate, install, template
    agent/
      config.ts                 CORE_POLICY (always-on) + DEFAULT_PERSONALITY
      instructions.ts           composeInstructions(): policy + agent + memory + skills
      provider.ts, provider-meta.ts   AI provider config + metadata; familyOf()
      llm.ts                    Provider-agnostic complete() + runToolLoop()
      openai-chat-adapter.ts    Forces OpenAI Chat Completions (not Responses)
      runtime.ts                CopilotRuntime options (wires MCP servers)
      tool-manifest.ts          Curated tool list shown in the Tools panel
      conversations.ts          VFS-backed thread + message store (keyed by agentId)
      conversations-sanitize.ts trimToSettledTail() (never resume an in-flight turn)
      card-collapse.ts          Event-card collapse store (timers OUTSIDE React)
      nested-events.ts          Encode/parse nested sub-agent event trees
      subagent-events.ts        Live delegation event store (keyed by task)
      review.ts                 Self-improvement review pass (memory + skill tools)
      memory/curated.ts, tool.ts        Curated USER.md/MEMORY.md + the memory tool
      skills/store.ts, improve.ts, curator.ts, usage.ts   Skill library + GEPA + Curator
      subagents/store.ts, types.ts, runner.ts, claude-runner.ts, tools.ts, markdown.ts
data/                           ALL runtime state (gitignored) — see below
apps/                           Installed apps — standalone git repo (GitFS), gitignored
```

---

## Data layout (`./data`, gitignored, `BOS_DATA_DIR`)

| Path | Contents |
|---|---|
| `data/vfs/` | The user VFS (Documents, Pictures, Desktop). Chat history at `data/vfs/Documents/Chats/<id>.json` — each file carries `agentId` (the sole partition key), `title`, `createdAt`, optional `activeFeatureBranch`, and the message array. Old files with a `group` field are migrated to `agentId` on first read. Active conversation per agent is tracked in `localStorage` as `bos.activeConversation.<agentId>`. Workflows at `data/vfs/Workflows/`. |
| `data/settings.json` | OS settings (wallpaper, accent, theme). |
| `data/config/<ns>.json` | Generic per‑namespace config (e.g. `dev-harness`, `browser-automation`, `datafs`, `assistant`, `build-studio`). |
| `data/provider.json` | AI provider config incl. the API key — **masked** in API responses. |
| `data/mcp-servers.json` | Chat MCP servers. |
| `data/memory/USER.md`, `data/memory/MEMORY.md` | Curated memory surfaces. |
| `data/skills/<id>/SKILL.md` (+ `scripts/`, `references/`) or `data/skills/<id>.md` | Skill library. `.usage.json` sidecar + `.archive/`. |
| `data/agents/<id>/AGENT.md` | Agent definitions — sub‑agents AND the assistant's personality agents. |

> **Schema compatibility:** because the Supervisor shares one canonical `data/`
> across versions and promote is code‑only, on‑disk `data/` schema changes MUST stay
> backward‑compatible (a future rollback would run prior code against the same store).

---

## Installed apps (`./apps`, gitignored, `BOS_APPS_DIR`)

A **standalone git repo** (GitFS), independent of the BOS source repo. Each app is
`<appsDir>/<id>/` with its files + an `app.json` manifest. No central registry —
apps are discovered by listing the directory. See
[Installed apps](./apps/installed-apps.md).

---

## Environment variables

| Var | Effect | Default |
|---|---|---|
| `BOS_DATA_DIR` | Runtime‑state root | `<cwd>/data` |
| `BOS_APPS_DIR` | Installed‑apps (GitFS) root | `<cwd>/apps` |
| `BOS_SPECS_ROOT` | Spec-store container root. The Supervisor sets it explicitly per version (020): previews → `<worktree>/specs` (store worktrees on the feature branch), base → the canonical root | `<cwd>/specs` |
| `BOS_SPECS_SEED` | `0` disables store seeding (set by the Supervisor for previews — seeding is base's job) | — |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Seed the default provider | — |
| `BOS_AGENT_MODEL` | Seed the default model | `claude-sonnet-4-6` |
| `BOS_MCP_SERVERS` | Comma‑separated MCP endpoints to seed | — |
| `BOS_DEV_HARNESS_URL` | Default remote Claude harness URL | `http://wingman.akhbar.lan:7272/mcp` |
| `BOS_SUPERVISOR_URL` | Set by the Supervisor so the app talks back to it | — (unset = in‑place) |

The Supervisor (`tools/supervisor/supervisor.mjs`) reads additional env vars
(`BOS_PUBLIC_PORT`, `BOS_PORT_BASE`, `BOS_PORT_POOL_SIZE`, `BOS_BASE_BRANCH`,
`BOS_WORKTREES`, `BOS_DATA_CLONES`, `BOS_CANONICAL_DATA`, `BOS_PUSH_MODE`, …) — see
[Live version control](self-modification/live-version-control.md).
