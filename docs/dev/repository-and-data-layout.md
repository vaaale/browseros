# Repository & data layout

## Repository map

```
seed/spec-store/                 Shipped bundle that seeds the system spec store (018)
.specify/templates/              spec-kit ENGINE (templates + command prompts) — stays in source
data/specs/  (BOS_SPECS_ROOT)    External spec stores — GITIGNORED, not tracked; seeded at
                                 runtime. Relocated from <cwd>/specs to <dataDir>/specs by 027
                                 so user specs live in the per-user data volume (survive a VFS
                                 wipe, isolated per user). Overridable via BOS_SPECS_ROOT — the
                                 Supervisor sets it to a preview's <worktree>/specs (020).
  bos-system-specs/              BOS-owned system store — READ-ONLY at runtime (Option B, 027):
                                 seeded/synced from seed/spec-store/; edited as SOURCE via the
                                 Developer agent. Organized into Projects (037) — a "bos" Project
                                 holds the NNN-feature specs (e.g. bos/000-browseros-core/); the
                                 store root itself still holds overview.md, discrepancies.md, and
                                 .specify/memory/constitution.md, outside any Project.
  user-specs/                    User-owned, writable store (own git repo); backs the
                                 Documents/Specs VFS mount (027 SpecFS). Also organized into
                                 Projects (037) — pre-existing content lives under the default
                                 "user" Project; a Project must be active (its own feature branch
                                 + git worktree under .worktrees/, below) before it can be edited.
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
    apps/[...slug]/route.ts     Serves installed items' app files through their
                                data/system/<id> item symlink (/apps/<id>/…)
    api/**/route.ts             All server endpoints (see api-reference.md)
  apps/                         Built-in apps — one self-describing folder each:
    <id>/manifest.ts            App metadata (AppManifest; folder name = id)
    <id>/index.tsx              Entry component (default export; "use client")
    _*.generated.ts             Auto-discovery output (gitignored; tools/gen-apps.mjs)
  core/service/                  Service daemons: ServiceRegistry, ServiceManager,
                                 CrashRecovery, DependencyResolver, PortChecker,
                                 manifestValidator, workerIpc, types
  system/marketplace/install/    Item-to-system symlink mapping (symlinkManager.ts),
                                 install/uninstall (serviceInstaller.ts)
  os/                           Framework-free OS core
    types.ts                    AppManifest, OSSettings, WindowInstance, VfsEntry …
    apps.ts                     BUILTIN_APPS (sorted) + getApp()
    data-dir.ts                 dataDir(): BOS_DATA_DIR or <cwd>/data  (runtime state
                                + installed items: one system/<id> symlink each)
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
    plugins/                    Agent-run hook pipeline: registry.ts, loader.ts, settings.ts,
                                types.ts, monitor.ts, validator.ts
    marketplace/                 schema.ts, client.ts — marketplace manifest + install glue
                                (apps, skills, specs, services, server plugins)
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
      memory/curated.ts, tool.ts        Curated USER.md/MEMORY.md + the memory tool
      skills/store.ts, improve.ts, curator.ts, usage.ts   Skill library + GEPA + Curator
      subagents/store.ts, types.ts, runner.ts, claude-runner.ts, tools.ts, markdown.ts
data/                           ALL runtime state (gitignored) — see below
```

---

## Data layout (`./data`, gitignored, `BOS_DATA_DIR`)

| Path | Contents |
|---|---|
| `data/vfs/` | The user VFS (Documents, Pictures, Desktop). Chat history at `data/vfs/Documents/Chats/<id>.json` — each file carries `agentId` (the sole partition key), `title`, `createdAt`, optional `activeFeatureBranch`, and the message array. Old files with a `group` field are migrated to `agentId` on first read. Active conversation per agent is tracked in `localStorage` as `bos.activeConversation.<agentId>`. Workflows at `data/vfs/Workflows/`. |
| `data/specs/` | External spec stores (`BOS_SPECS_ROOT`, 027), each organized into Projects (037-project-layer, `<store>/<project-id>/...` — pure organizational folders, no git-activation of their own). `bos-system-specs/` (**read-only, unconditionally**, seeded from `seed/spec-store/`) + `user-specs/` (writable only on a real `bos/*` feature branch — the same one used for BOS's own source; backs the `Documents/Specs` SpecFS mount). `.worktrees/<storeId>/<branch>` holds `os/fs/spec-fs.ts`'s self-provisioned 020 feature-branch worktrees (used when the Supervisor isn't running). |
| `data/settings.json` | OS settings (wallpaper, accent, theme). |
| `data/config/<ns>.json` | Generic per‑namespace config (e.g. `dev-harness`, `browser-automation`, `datafs`, `assistant`, `build-studio`). `plugins.json` holds the hook-pipeline's active set + order + per-plugin config. |
| `data/user-apps/` | The user's own private **marketplace** repo (002-service-daemons, 034) — the same layout as any marketplace clone: `marketplace.json` + `items/<id>/`. BOS ensures it's a git repo (`ensureRepo()` at boot, a no-op if the user already cloned their own remote) and maintains `marketplace.json` by merge, but never populates or deletes item content. Each `items/<id>/` is a service/app item source (`services/`, `config/`, optional `app/`/`spec/`/`doc/`/`hooks/`); `dataDir()/system/*` symlinks point at `items/<id>/…` once installed. Keyed internally as `LOCAL_MARKETPLACE_ID = "user-apps"` — a location, not the repo's identity. |
| `data/system/<item-id>` | **The** installed-state record (035): one symlink per item, pointing at the item wherever it lives (`data/marketplace/<mktId>/items/<id>` or `data/user-apps/items/<id>`). Facets are found by a depth-2 scan through it — `<id>/app/`, `<id>/services/service.json`, `<id>/plugin/bos-plugin.json`, `<id>/spec/`, `<id>/hooks/`. Uninstalling is one `rm`. Installing copies nothing. |
| `data/system/config/<item-id>/` | BOS-owned mutable state for an item: its `config/` defaults seeded at install, plus what BOS and the item write at runtime (`runtime.json`, `capabilities.json`). Survives uninstall, so a reinstall keeps the user's settings. The one permitted copy — config must never live inside a read-only marketplace clone. |
| `data/config/<id>/` | Symlink to a service item's `config/` dir; holds its user-editable config file(s) plus a manager-owned `runtime.json` (actual bound port/host). |
| `data/marketplace/<mktId>/items/<itemId>/` | Marketplace item clones (source for `installMarketplaceItem`/`installServerPlugin`, left in place after uninstall for re-install). |
| `data/logs/services/<id>.log` | Service worker stdout/stderr, tailed by the Settings log viewer. |
| `data/provider.json` | AI provider config incl. the API key — **masked** in API responses. |
| `data/mcp-servers.json` | Chat MCP servers. |
| `data/memory/USER.md`, `data/memory/MEMORY.md` | Curated memory surfaces. |
| `data/skills/<id>/SKILL.md` (+ `scripts/`, `references/`) or `data/skills/<id>.md` | Skill library. `.usage.json` sidecar + `.archive/`. |
| `data/agents/<id>/AGENT.md` | Agent definitions — sub‑agents AND the assistant's personality agents. |

> **Schema compatibility:** because the Supervisor shares one canonical `data/`
> across versions and promote is code‑only, on‑disk `data/` schema changes MUST stay
> backward‑compatible (a future rollback would run prior code against the same store).

---

## User apps (`data/user-apps/`, 002-service-daemons)

The user's **own** private **marketplace** — a GitFS repo with exactly the same
shape as the central one, so the same repository can serve as either
(`034-user-apps-marketplace-parity`):

```
data/user-apps/
├── marketplace.json          ← BOS-maintained, by MERGE (see below)
└── items/<id>/               ← services/, config/, optional app/ spec/ doc/ hooks/
```

BOS runs `ensureRepo()` on it at boot (a no-op if the user already cloned their
own remote there) and never populates or deletes item content. Installing an item
only ever creates symlinks under `dataDir()/system/`; uninstalling only ever
removes them. This is the ONE install target for every item, **apps included** —
assistant-built apps land at `items/<id>/app/`, there is no separate apps repo
(see [Installed apps](./apps/installed-apps.md)).

**BOS does maintain `marketplace.json`**, which reverses the earlier "never write
generated artifacts here" rule. It writes only that one file, only by
reconciliation — add entries for new `items/` directories, prune entries whose
directory is gone, never touch a field it did not author — and only when the
serialized result actually differs from what is on disk, so reading the catalog
never dirties the repo. Regeneration is forbidden: curated `tags`, `icon`,
descriptions, non-standard entrypoints (`items/x/app/dist`) and plugin facets
(`voiceEngine`, `runtime: "plugin-served"`) exist only in the manifest.

`LOCAL_MARKETPLACE_ID = "user-apps"` is the internal key for *this slot*,
identified by **location**, not the repo's identity — the displayed name and id
come from its own `marketplace.json`. A fresh, uninitialised repo is named
`<username>-marketplace` from the bastion-injected `x-bos-username`, which is why
that happens lazily on the first catalog read rather than at boot. Registering a
remote whose manifest id matches the local one is rejected as a duplicate. The
slot shows up as its own entry in Settings → Versions. See
[Service Daemons](./apps/services.md).

---

## Environment variables

| Var | Effect | Default |
|---|---|---|
| `BOS_DATA_DIR` | Runtime‑state root (includes installed items under `user-apps/` + `system/`) | `<cwd>/data` |
| `BOS_SPECS_ROOT` | Spec-store container root. The Supervisor sets it explicitly per version (020): previews → `<worktree>/specs` (store worktrees on the feature branch), base → the canonical root | `<dataDir>/specs` |
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
