# Repository & data layout

## Repository map

```
seed/spec-store/                 Shipped bundle that seeds the system spec store (018)
seed/method-packs/<id>/          METHOD PACK: descriptor (method.json) + templates + agents/ + skills/
                                 spec-kit ships as one; `.specify/` is gone (046)
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
| `data/vfs/` | The user VFS (Documents, Pictures, Desktop). Chat history at `data/vfs/Documents/Chats/<id>.json` — each file carries `agentId` (the sole partition key), `title`, `createdAt`, optional `activeFeatureBranch`, optional `archived` (missing = `false`; hidden from default lists + read‑only until unarchived), and the message array. Old files with a `group` field are migrated to `agentId` on first read. Active conversation per agent is tracked in `localStorage` as `bos.activeConversation.<agentId>`. Workflows at `data/vfs/Workflows/`. |
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

## Registered repositories (050)

A spec store is discovered by **scanning `BOS_SPECS_ROOT`** for a directory —
symlinks included — carrying a `spec-store.json`. There is **no registry file**,
deliberately: a second list beside the scan that already answers "which
repositories exist" is the shape of every "my repo vanished" report. Registering
writes exactly what the scan reads:

```
clone or git init  ->  ensure the method's store root  ->  write spec-store.json  ->  symlink
```

Removing the symlink is a complete deregistration. Every step is inspectable on
disk.

### A store root may live INSIDE its repo

`SpecStore` separates two paths, and they are not always the same directory:

| Field | Is | Used for |
|---|---|---|
| `root` | what spec-fs jails writes to | reads/writes, path containment |
| `repoRoot` | the git repo that versions it | history, `git show <ref>:<path>`, branch state |

Three shapes, one rule — **`repoRoot` is the nearest ancestor holding `.git`**:

| Store | `root` | `repoRoot` |
|---|---|---|
| `user-specs` | the repo itself | the same directory |
| an item | `user-apps/items/<id>/spec` | the shared `user-apps` repo |
| a project | `<repo>/openspec` | `<repo>` |

**The walk up is bounded to one level** (`MAX_REPO_WALK_UP`). Unbounded, it
adopts any unversioned directory into whatever repo sits above it — and under
the data dir that is **BOS's own checkout**, which would then version a user's
specs and accept git writes against it. A method-declared store root is one path
segment, so one level covers every real case. Raise it only when a method
declares a deeper offset; make the declaration the reason.

### Where a method puts its specs

`MethodDescriptor.storeRoot` — one segment, relative to the repo root:

| Method | `storeRoot` |
|---|---|
| spec-kit | `specs` |
| BMAD | `docs` |
| OpenSpec | `openspec` |

BOS does not invent a location. A framework's own CLI must keep working on the
same checkout, so specs go where that framework looks for them. **This bounds
the spec store, not BOS** — ordinary development writes go anywhere in the repo,
because driving a pipeline over an application you cannot edit is pointless.
Conflating the two is a mistake worth naming: they are different write paths
with different rules, and only the first is jailed.

### Kind

`spec-store.json` carries `kind` — `system` / `user-specs` / `marketplace` /
`arbitrary`. **Recorded, not inferred**, so it survives a restart and travels
with the repository rather than being guessed from where a directory sits.

An **absent** `kind` keeps today's behaviour exactly (a directory-scanned store
is `user-specs`), so no existing store changes meaning and there is no migration.

Kind decides binding scope and what a Project is — see `src/lib/specs/store-kind.ts`
and 049's table. **Kind and ownership are different axes**: only
`bos-system-specs` is BOS-owned and read-only; every other kind, arbitrary repos
included, is the user's and writable on a branch.

### "The store IS one project" is about BINDING, not nesting

050's table reads *the repo **is** one project* for `user-specs` and for an
arbitrary repo. That is the **binding scope** column's companion: one workflow
governs the whole repository. It does not remove the 037 Project folders — the
directories under a store (`build-studio/`, `assistant/`, …) still exist, still
scope feature numbering, and are still created and renamed through
`lifecycle.ts`.

So Build Studio calls them **folders**, not Projects, in everything a user
reads. A repository the user added IS their project; offering "New project"
inside it described the model's unit and said nothing true to the person looking
at it. The server ops keep the `*-project` names — that is the unit's name in the
model, not a word for the UI.

### Store discovery exists twice, and must agree

`src/lib/specs/stores.ts` decides what BOS treats as a store.
`tools/supervisor/lib/coupled-repos.mjs` decides what gets **mounted as a
worktree** for a feature branch. They are separate processes — the Supervisor is
plain ESM with no TS build — so the rule is written twice, and the two copies
must stay identical: a store BOS will happily write to, but the Supervisor never
mounts, has nowhere to put the write.

They drifted, silently, in two ways that each make a store unwritable on a branch:

- **`Dirent.isDirectory()` is false for a symlink.** `readdir` does not follow
  links, and a store is routinely a symlink into a repo kept outside the data
  dir. In such a deployment the Supervisor mounted *nothing at all*.
- **`.git` was required INSIDE the store root.** That skips any store that is a
  *subdirectory* of its repo — exactly the shape 050 gave registered
  repositories, whose specs live at `<repo>/specs` or `<repo>/openspec`.

Both are fixed, and `tests/specs/symlinked-store-discovery.test.ts` pins the
agreement by running the Supervisor's own `listSpecStores()` in a child process
(its `SPECS_ROOT` is read at module load, so it has to be a real process) and
comparing the result to `listStores()` on one fixture.

**A mount is the store's REPO, not the store.** For most stores they are the same
directory. For a registered repository they are not, so the mount is the whole
project and `resolveInStore` descends by
`path.relative(store.repoRoot, store.root)` to reach the store inside it. The
offset is derived from what BOS already resolved rather than reported by the
Supervisor — one less thing the two sides have to agree about.

### Every write needs a feature branch — creating a folder included

`prepareWrite` (`src/lib/dev/spec-fs.ts`) has no exemptions. A Project manifest
used to be one, so that making an empty folder did not require picking a branch.
That was defensible while every store was BOS's own and became wrong the moment
050 admitted the user's repositories, where the write is a commit on their
branch. It also produced a half-made thing: the folder landed on the default
branch, and every attempt to put content in it was then refused.

The refusal is a `BranchRequiredError` carrying `code: "branch_required"`
(`src/lib/specs/error-codes.ts`, framework-free so the client can import it).
The message is written for an AGENT — it names `dev_branch_request`, its
argument, and the retry, because a sub-agent that hits this mid-run cannot guess
the recovery. The code is what lets Build Studio recognise the case and address
a person instead, without matching on prose.

### Refusals

Registration refuses rather than warns, because both cases put two jails over
one worktree and diverge silently:

- **Duplicate** — by resolved path, and by remote URL normalised across
  `git@host:owner/repo.git` / `https://host/owner/repo`.
- **Nested** — in either direction, relative to an already-registered repo.

A failed registration rolls back in reverse and leaves nothing: partial
registration is worse than failure, because it looks like success *and* blocks
the retry.

### One writable marketplace

`user-apps` only. `LOCAL_MARKETPLACE_ID` is singular through
`marketplace/client.ts` (18 call sites), `item-stores.ts` scans one directory by
design, and — the real cost — `user-apps` is **branch-coupled** (038): `spec-fs`
resolves `<previewDataDir>/user-apps` so an item's spec travels with its app's
code onto a feature branch. A second writable marketplace needs that same
coupling, which is Supervisor worktree machinery rather than a loop over a list.

Deferred until *sharing* is the need. Organising a large collection does not
justify it.

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
