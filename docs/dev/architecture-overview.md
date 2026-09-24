# BrowserOS Subsystem Architecture Report

## Overview

BrowserOS is a single-page, server-side-rendered "operating system in the browser" built with Next.js App Router, React, Zustand, and CopilotKit. The codebase has grown organically and contains several distinct subsystems that, while well-organized by folder, lack explicit layering boundaries and formal interfaces between them.

---

## Subsystem Inventory

### 1. Core OS Layer (`src/os/`)

**Stability: HIGH — lowest layer, should change rarely**

| File | Responsibility |
|------|---------------|
| `types.ts` | Framework-free shared types (AppManifest, OSSettings, WindowBounds, VfsEntry) |
| `data-dir.ts` | Runtime data directory resolver (`BOS_DATA_DIR` env var) |
| `apps-dir.ts` | Apps directory resolver |
| `specs-dir.ts` | Specs directory resolver |
| `atomic-write.ts` | Atomic file writing utility |
| `settings.ts` | Core OSSettings CRUD (wallpaper, theme, accent) |
| `vfs.ts` | Virtual filesystem implementation (also hosts GitFS) |
| `apps.ts` | Built-in apps discovery |
| `wallpapers.ts` | Wallpaper configuration |

**Dependencies:** None (lowest level).
**Exposed Interfaces:** `dataDir()`, VFS operations (`read`, `write`, `list`, `mkdir`, `remove`, `rename`), `getSettings()` / `updateSettings()`, `BUILTIN_APPS`.

---

### 2. State Management Layer (`src/store/`)

**Stability: MODERATE — well-defined surface, but high coupling to UI**

| File | Responsibility |
|------|---------------|
| `os-store.ts` | Zustand store for windows, settings, apps |
| `os-provider.tsx` | React context provider for the store |

**Responsibilities:** Window lifecycle (launch, close, focus, move, resize, minimize, maximize), z-index ordering, focused window tracking, settings state, app registration/unregistration.

**Dependencies:** `src/os/types.ts` (types only).
**Exposed Interfaces:** `useOSStore()`, `useOSStoreApi()`, `OSProvider`.

---

### 3. Virtual File System (VFS) (`src/os/vfs.ts`)

**Stability: HIGH — contract is narrow and well-defined**

The VFS is the user's sandbox — an isolated file system backed by `data/vfs/`. It provides path traversal protection and is the only storage mechanism for user-authored content (documents, chat history). Conversations live in `Documents/Chats` to survive preview clones.

**Dependencies:** `src/os/data-dir.ts`, `src/os/atomic-write.ts`, `src/os/types.ts`.

---

### 4. GitFS / DataFS (`src/lib/gitfs/`, `src/lib/datafs/`)

**Stability: MODERATE — design is evolving**

| File | Responsibility |
|------|---------------|
| `store.ts` (gitfs) | Git-backed version control for user-authored content |
| `store.ts` (datafs) | Data isolation (clone, probe) |

**Responsibilities:** Independent git repos per root (apps, workflows). Provides branching, history, and marketplace-ready portability. Self-describing directories with `app.json` manifests.

**Dependencies:** `src/os/apps-dir.ts`.

---

### 5. Apps System (`src/lib/apps/`, `src/apps/`)

**Stability: MODERATE-HIGH — discovery pattern is stable, bundling is evolving**

| File | Responsibility |
|------|---------------|
| `src/lib/apps/store.ts` | Installed apps CRUD |
| `src/lib/apps/build.ts` | esbuild bundler for multi-file apps |
| `src/apps/<id>/manifest.ts` | Built-in app self-describing manifest |
| `src/components/apps/registry.tsx` | Component registry |
| `src/components/apps/IframeApp.tsx` | Iframe renderer |
| `src/app/apps/[...slug]/route.ts` | Static file serving |

**Responsibilities:** Discover and manage installed apps. Built-in apps are React components discovered from `src/apps/`; installed apps are the `app/` facet of an ITEM under `dataDir()/user-apps/items/<id>/` (the user's GitFS repo), installed by one symlink, `dataDir()/system/<id>` → the item (035) and served through that symlink as iframes — the same item-to-system mechanism services use (002).

The **Marketplace app** — the UI for browsing every content source and installing from it — is a master-detail layout (a source sidebar filtering collapsible per-source sections); see [apps/marketplace-app.md](./apps/marketplace-app.md).

**Dependencies:** `src/os/data-dir.ts`, `src/lib/gitfs/store.ts`, `src/system/marketplace/install/symlinkManager.ts`.
**Exposed Interfaces:** `listInstalledManifests()`, `installItem()` (installs a full item — app and/or service facets, not app-only), `installItemApp()`, `uninstallApp()`, `purgeApp()`, `buildAppDir()`, `toManifest()`, `setAppCapabilities()`. (Uninstall is final under 035 — no `restoreApp()`; reinstalling is a Marketplace action.)

---

### 6. Services & Plugin Pipeline (`src/core/service/`, `src/system/marketplace/install/`, `src/lib/plugins/`)

**Stability: MODERATE — backend implemented; UI/marketplace wiring still evolving**

| File | Responsibility |
|------|---------------|
| `src/core/service/ServiceRegistry.ts` | Service discovery (source vs. installed state), event stream |
| `src/core/service/ServiceManager.ts` | Worker-thread lifecycle (start/stop/restart), IPC |
| `src/core/service/CrashRecovery.ts`, `DependencyResolver.ts`, `PortChecker.ts` | Exponential-backoff restarts, topological startup order, port-conflict detection |
| `src/system/marketplace/install/symlinkManager.ts`, `serviceInstaller.ts` | Item-to-system symlink mapping, install/uninstall (never touches item source) |
| `src/lib/plugins/registry.ts`, `loader.ts`, `settings.ts` | Agent-run hook pipeline: registration, composition into `RunHooks`, Settings persistence |

**Responsibilities:** Two related but independent systems that share one Settings
tab ("Plugins"). **Services** are long-running worker-thread daemons installed
from `dataDir()/user-apps/` (the user's own GitFS repo — same concept as
`user-specs/`) or a marketplace clone (e.g. a Terminal WebSocket service).
**Plugins** hook into the assistant's run loop (`beforeRun`/
`afterToolCall`/etc.) — `bos-compaction` and `bos-memory` are the two built-ins.

**Dependencies:** `src/os/data-dir.ts`; plugins additionally hook into
`src/lib/assistant/start-run.ts`.

**Exposed Interfaces:** `serviceRegistry()`, `serviceManager()`, `installService()`/
`uninstallService()`; `registerPlugin()`, `listPlugins()`,
`composePluginHooks()`.

→ [Service Daemons](apps/services.md) · [Plugin pipeline](plugins/plugin-pipeline.md)

---

### 7. Configuration System (`src/lib/config/`)

**Stability: MODERATE — namespace model is stable, schemas evolve**

| File | Responsibility |
|------|---------------|
| `registry.ts` | Config namespace registry (515 lines) |
| `store.ts` | Namespace JSON storage |
| `types.ts` | Config schema types |

**Responsibilities:** Pluggable settings tabs (15+ namespaces), load/save abstractions, map UI controls to config values, expose settings as assistant tools.

**Config Namespaces:** `appearance`, `ai-provider`, `assistant`, `skills`, `mcp`, `apps`, `integrations`, `dev-harness`, `browser-automation`, `datafs`, `self-modification`, `system-tools`, `run-command`, `memoryLoops`, `compaction`, `logging`, `build-studio`, `tools`.

**Dependencies:** `src/os/settings.ts`, `src/lib/agent/provider.ts`.

---

### 8. Agent / Assistant System (`src/lib/agent/`)

**Stability: LOW — most rapidly evolving layer**

This is the most complex subsystem, with multiple sub-components:

#### 8.1 Core Agent Runtime
| File | Responsibility |
|------|---------------|
| `config.ts` | CORE_POLICY, DEFAULT_PERSONALITY |
| `runtime.ts` | CopilotRuntime builder |
| `provider.ts` | LLM provider configuration |
| `provider-meta.ts` | Provider list and metadata |
| `conversations.ts` | Client-side conversation state |
| `conversations-server.ts` | Server-side conversation persistence |
| `llm.ts` | LLM client abstraction |
| `instructions.ts` | Instruction composition |
| `tool-manifest.ts` | Tool registration manifest |

#### 8.2 Capabilities Registry
| File | Responsibility |
|------|---------------|
| `capabilities-registry.ts` | Unified capability definitions (~150 capabilities). `Capability.group` is a group **id** (a slug), not a display name — see below |
| `tool-groups.ts` | The tool-group model (041): id, display name, description, search aliases; built-in table + a `globalThis` dynamic layer for service-declared groups |
| `tool-group-overrides.ts` | User edits to a group's description/aliases (Settings → Tools), persisted per group id |
| `discovery-search.ts` | Deterministic term-level IDF ranking behind `find_tools` |

**Capability groups (041-tool-groups):** OS, Web, Files, Config, Agents,
Conversation Review, Memory, Skills, Scratchpad, MCP, Apps, Specs, Dev, Conflict
Resolution, Scheduler, Build Studio, UI Preview, Gmail, Google Drive, Google
Calendar, Google Contacts, Telegram — plus one group per installed
tool-exposing marketplace item, registered at runtime.

The built-in table in `tool-groups.ts` is the canonical ORDER (it drives both
Settings and the system-prompt block), and group ids are the stable join key for
capabilities, user overrides and manifest declarations. **There is no fallback
group**: an unresolvable group id is surfaced as an error, never bucketed.

#### 8.3 Sub-agents (Delegation)

Definitions (`subagents/store.ts`, `types.ts`, `markdown.ts`) and the Claude
dev-harness runner (`subagents/claude-runner.ts`) still live under
`src/lib/agent/subagents/`, but chat-initiated delegation itself
(`agent_delegate`/`dev_delegate`) now runs through the **unified assistant
engine** in `src/lib/assistant/` — see
[Sub-agents & delegation](assistant/sub-agents-and-delegation.md) for the full
model (named/ephemeral/surface delegation kinds, the shared `runInnerLoop`
primitive, the depth guard, and the single tool gate that replaced
`subagents/tools.ts`, which was retired).

| File | Responsibility |
|------|---------------|
| `subagents/store.ts` | Agent definitions |
| `subagents/types.ts` | Agent type definitions |
| `subagents/runner.ts` | `runSubAgent` — headless-caller entry point only (workflows, scheduler, Telegram, `/api/subagents/delegate`); its `type:"local"` branch (`runLocalHeadless`) runs a real `runAgentLoop` |
| `subagents/claude-runner.ts` | Claude Code runner (unchanged; used by both chat and headless delegation) |
| `subagents/markdown.ts` | Agent.md parsing |
| `subagent-events.ts` | Event streaming |
| `assistant/inner-loop.ts` | The shared delegation execution primitive (a second `runAgentLoop` invocation) + depth guard |
| `assistant/delegation-gate.ts` | Resolves each delegation kind's tool gate + system prompt |
| `assistant/tools/server/delegate-common.ts`, `delegate-local.ts`, `dev-delegate.ts` | `agent_delegate`/`dev_delegate` tool implementations |
| `assistant/client/surface-agents.ts` | Window-scoped surface-agent registry (client-side) |

#### 8.4 Memory System
| File | Responsibility |
|------|---------------|
| `memory/injection.ts` | Memory injection into instructions |
| `memory/tool.ts` | memory_save/memory_recall actions |
| `memory/episodes.ts` | Conversation episode extraction |
| `memory/topics.ts` | Topic-sharded long-term memory |
| `memory/consolidate.ts` | Slow loop consolidation |
| `memory/fast-loop.ts` | Fast loop idle review |
| `memory/search.ts` | Memory search |
| `memory/config.ts` | Memory loop configuration |

#### 8.5 Skills System
| File | Responsibility |
|------|---------------|
| `skills/store.ts` | Skill CRUD |
| `skills/improve.ts` | Skill improvement (GEPA) |
| `skills/curator.ts` | Skill curation and archiving |
| `skills/usage.ts` | Skill usage tracking |

#### 8.6 Compaction System
| File | Responsibility |
|------|---------------|
| `compaction/middleware.ts` | Context compression middleware |
| `compaction/view.ts` | Message view transformation |
| `compaction/canonical.ts` | Canonical message format |
| `compaction/estimate.ts` | Token estimation |
| `compaction/summarize.ts` | Async summarization |
| `compaction/config.ts` | Compaction settings |

**Dependencies:** `src/lib/config/store.ts`, `src/lib/mcp/client.ts`, `src/lib/automation/playwright-mcp.ts`.

---

### 9. Specs System (`src/lib/specs/`, `src/lib/dev/spec-fs.ts`)

**Stability: LOW-MODERATE — pipeline is evolving**

| File | Responsibility |
|------|---------------|
| `stores.ts` | Spec store discovery |
| `item-stores.ts` | Item-owned spec store discovery (an installed item's own `spec/` facet) |
| `create.ts` | `createItemSpec()` — brings a marketplace item into existence from just a spec |
| `store-git.ts` | Git operations for spec stores |
| `seed.ts` | Spec store seeding (incl. one-time migration of pre-Project content into default Projects) |
| `projects.ts` | Project discovery/creation within a directory-scanned store (037-project-layer) — pure organizational folders, no git-activation of their own |
| `pipeline.ts` | Spec-kit pipeline orchestration (recursive store → Project → feature-leaf walk) |
| `types.ts` | Spec type definitions |
| `dev/spec-fs.ts` | Multi-root spec filesystem — Build Studio's own read/write path (`/api/specs`) |
| `os/fs/spec-fs.ts` | The VFS `SpecFS` backend mounted at `/Specs/<store>` — the generic `file_*` tools' path; a SEPARATE implementation from `dev/spec-fs.ts` above, kept in sync with the same branch-coupled routing and its own `writable` gate |

**Responsibilities:** External spec stores (system, user, marketplace), a **Project** layer inside every directory-scanned store (037-project-layer: `<store>/<project-id>/...`, with arbitrary plain sub-folders below a Project — a directory is a feature leaf iff it directly contains `spec.md`; feature numbering resets per Project). A Project is a pure organizational folder with no independent git-activation — instead, each store reuses a PRE-EXISTING mechanism: `bos-system-specs` is **read-only, unconditionally**, everywhere (Build Studio's own `/api/specs` path AND the agent's generic `file_*` tools — both gate on the store's `writable` flag, `false` for this store); `user-specs` — a user's own customization to BOS core (including built-in apps) — is writable only on a real `bos/*` feature branch, the SAME branch used for BOS's own source code (selected via the assistant chat's "Active feature branch" dropdown, reused as-is — Build Studio has no separate picker). A fourth store kind, `owner: "item"`, is not a directory under `BOS_SPECS_ROOT` at all — it's an installed item's own `spec/` folder (`item-stores.ts`, sourced from `listInstalledItems()`), rooted so the item's `app/`/`services/`/`plugin/` siblings stay unreachable through spec-fs. It has no feature-id subfolder (the whole store IS the one spec) and is writable only when the item is the user's own (`user-apps`); writes there go through `commitScoped` (`src/lib/gitfs/store.ts`), not `commitAll`, since the store root is a subdirectory of an already-initialized repo rather than a repo root of its own. An item store has no Project, and no git-activation of its own: `data/user-apps` is a branch-COUPLED repo like every spec store (`coupled-repos.mjs`'s `coupledReposFor` mounts it on the active `bos/*` feature branch at `<previewDataDir>/user-apps`), so an item's spec travels with its app/service code AND with BOS's own source, and promotes or discards as one operation. Writes require that feature branch exactly as `user-specs` does — `prepareWrite` gates EVERY writable store unconditionally (only branch *routing* is Supervisor-conditional), so the agent hits the same `dev_branch_request` elicitation everywhere. Item stores need their own resolver (`branchItemStoreRoot`) only because `user-apps` is a different repo from the `<codeWorktree>/specs/<storeId>` mounts — a path difference, not a policy one. Anything addressing git by repo (history listing, `git show <ref>:<path>`, which resolves paths against the repo root) uses `store.repoRoot` + `storeRepoRelative()`, since an item store's root is a subdirectory of `user-apps` with no `.git` of its own. Item CONTENT follows the same rule as item specs: `installItem` resolves a data root with `branchDataRoot()` (`src/lib/devharness/branch-data-root.ts`), so `app_install`/`app_build`/`createItemSpec` run from BASE and land on the active feature branch — `dataDir()` stays a per-process constant and the redirect is explicit rather than ambient. The Supervisor's former global **app-candidate** branch — a second, in-place branch scheme over the same repo, surfaced as Build Studio's per-item Activate/Promote/Discard row and `VersionControls.tsx`'s "Promote app"/"Discard app" buttons — is **retired**, along with the `liveCheckoutOwners` registry that existed only to keep the two schemes from colliding. This is the **primary** authoring location for a marketplace item's spec, not just a viewer for an already-bundled one — `create.ts`'s `createItemSpec()` (exposed as the `app_spec_create` tool, `src/lib/assistant/tools/server/specs.ts`) calls `installItem()` (`src/lib/apps/store.ts`) to bring the item into existence directly from a spec, before any app/service/plugin code exists, deliberately overriding spec-kit's original "centralize everything in user-specs, classify via an App Target field" convention for this one target type. `app_spec_list/read/write/edit/patch` round out read/write access to item stores from any chat context, not just Build Studio's own window-scoped tools — scoped ONLY to `owner: "item"` stores; BOS-core/user specs are unaffected and keep using `file_*` on `/Specs/`. `createItemSpec()`'s id is validated against traversal (`isSafeItemId()`, `src/lib/apps/store.ts`, enforced inside `installItem()` itself so every caller — `app_install`/`app_build` included — is covered, not just this path) and preflight-checked against reserved ids and cross-origin collisions before any write, and concurrent calls for the same name/id are serialized (an in-process per-key lock) so two racing creates can't clobber each other. Display-name/origin-label lookups live in their own module, `src/lib/marketplace/item-manifest.ts` — deliberately independent of `src/lib/marketplace/client.ts`, whose own static imports would otherwise close a real circular-dependency chain back through `stores.ts`.

**Path Format:** `<storeId>/<relPath>` — e.g., `bos-system-specs/core-platform/000-browseros-core/spec.md` (`core-platform` is one of several Projects `bos-system-specs` is organized into, 037-project-layer; `.specify/memory/constitution.md` stays at the store root, outside any Project). Item-owned stores have no Project segment (the whole store IS the one spec): `item-<id>/spec.md`.

---

### 10. MCP (`src/lib/mcp/`)

**Stability: MODERATE — protocol is external, integration is stable**

| File | Responsibility |
|------|---------------|
| `gateway.ts` | MCP tool gateway |
| `client.ts` | MCP client factory |
| `store.ts` | MCP server configuration |
| `types.ts` | MCP type definitions |
| `ui.ts` | MCP UI components |
| `validate.ts` | Schema validation |

**Dependencies:** Integrated with agent runtime (tools exposed to the assistant).

---

### 11. Desktop Shell (`src/components/desktop/`)

**Stability: MODERATE — UI-heavy, refactors are common**

| File | Responsibility |
|------|---------------|
| `Desktop.tsx` | Main desktop layout |
| `WindowManager.tsx` | Window orchestration |
| `Window.tsx` | Individual window component |
| `Topbar.tsx` | Top bar (agent selector, branch, etc.) |
| `Dock.tsx` | Application dock |
| `icons.tsx` | Lucide icon renderer |
| `VersionControls.tsx` | Version control UI |
| `FirstRunWizard.tsx` | Initial setup |
| `IntegrationsBadge.tsx` | Integration status |

**Dependencies:** `src/store/os-store.ts`, `src/os/wallpapers.ts`.

---

### 12. API Routes Layer (`src/app/api/`)

**Stability: MODERATE-HIGH — routes are thin delegates**

| Route | Delegates To |
|-------|-------------|
| `api/assistant/` | CopilotKit adapter, agent, title generation |
| `api/agent/` | Agent actions (reflect, discovery, feature branches) |
| `api/apps/` | Apps system |
| `api/services/` | Service daemons system |
| `api/plugins/` | Plugin pipeline |
| `api/marketplace/` | Marketplace (apps/skills/specs/services/server-plugins) |
| `api/config/` | Config system |
| `api/fs/` | VFS |
| `api/datafs/` | DataFS |
| `api/memory/` | Memory system |
| `api/skills/` | Skills system |
| `api/subagents/` | Sub-agents |
| `api/specs/` | Specs system |
| `api/integrations/` | Integrations system |
| `api/mcp/` | MCP |
| `api/proxy/` | Web proxy |
| `api/web-fetch/` | URL fetching |
| `api/web-search/` | Web search |
| `api/compaction/` | Compaction summaries |
| `api/scheduler/` | Background jobs |
| `api/dev/` | Dev harness |
| `api/docs/` | Documentation |
| `api/health/` | Health check |
| `api/logs/` | Logging |
| `api/settings/` | Settings |

**Pattern:** Each route is a thin delegate to the appropriate subsystem. Actions register tools via `src/components/agent/*Actions.tsx` and mirror in `src/lib/agent/tool-manifest.ts`.

---

### 13. Integrations (`src/lib/integrations/`)

**Stability: MODERATE — adapters evolve with upstream APIs**

| File | Responsibility |
|------|---------------|
| `registry.ts` | Integration registry |
| `types.ts` | Integration type definitions |
| `actions/` | Action adapters (Gmail, Drive, Calendar, Contacts) |
| `adapters/` | OAuth flows, token management |
| `webhooks/` | Webhook handling |
| `scheduler/` | Polling schedules |
| `state/` | Integration state management |
| `secrets/` | Client secret storage |

**Current Integrations:** Gmail, Google Drive, Google Calendar, Google Contacts, Telegram.

---

### 13.5. Generic Service Secrets & Headless Client Auth (`src/lib/secrets/`)

**Stability: MODERATE — mechanism is fixed; consumers will grow over time**

| File | Responsibility |
|------|---------------|
| `service-secrets.ts` | `createSecret`/`verifySecret`/`listSecrets`/`revokeSecret`/`hasAnySecret`, namespaced by an arbitrary `service` string any BOS feature chooses |
| `credentials-index.ts` | Per-user plaintext routing companion file (`data/system/credentials-index.json`) — a fast, unsalted hash lookup aid for Bastion, never itself sufficient to authenticate |

Lets any server-side feature mint its own scoped, revocable credential for a
non-browser client (a mount client, a CLI) without a bespoke per-protocol
token store, and — with zero Bastion code changes per new consumer — get
routed correctly behind the multi-user Bastion proxy regardless of its
configured identity provider. See `docs/dev/features/headless-client-auth.md`
for the full mechanism and adoption checklist; the Bastion-side half
(`bastion/src/credential-routing.ts`) is covered in §16 below.

---

### 13.6. Event & Notification System (`src/lib/events/`)

**Stability: MODERATE — new in 034-event-notification-system**

| File | Responsibility |
|------|---------------|
| `types.ts` | Framework-free shared types (`EventRecord`, `EventState`, `HandlerRegistration`, ...) — imported by both server code and the client viewer |
| `store.ts` | Persistence: per-month immutable JSONL shards + per-month mutable state + a warm-in-memory unbounded index, flushed on a checkpoint cadence (not per-emit) |
| `kernel.ts` | The `globalThis`-backed daemon singleton — every public op (emit/ack/query/register/...), the two-axis state machine, boot re-dispatch |
| `dispatch.ts` | Fan-out to headless handlers: per-handler FIFO queues (concurrent across handlers), retry/backoff, at-least-once re-dispatch, exactly-once-settle |
| `stream.ts` | In-memory state-change stream backing `GET /api/events/stream` (NDJSON, replay-then-tail) |
| `api.ts` | The single public API facade (request validation) — reached in-process, over same-origin HTTP, and over loopback HTTP (worker-thread services) |
| `migrate-integrations.ts` | One-time, idempotent migration of the legacy GSuite/Telegram notification inbox onto this system |
| `register-ui-handlers.ts` | Surfaces every app's manifest-declared `eventHandlers` into the registry at boot |

A pub/sub broker, in-process (a daemon started from `instrumentation.ts`,
sibling to the scheduler daemon in §1 — not a worker-thread service; unlike the
scheduler it is not owner-elected, see
[Scheduler concurrency](automation/scheduler-concurrency.md)). Any
component emits an event (type + JSON payload); the kernel durably records
it (a single O(1) shard append) and fans out to matching **headless
handlers** (invoked automatically, must ack, participate in a
pending→processed state machine) without blocking the emitter. **UI
handlers** are a separate, static, click-resolved layer (declared in
`AppManifest.eventHandlers`, §5) that launch an app window when the user
clicks an event in the built-in **Event Viewer** (`src/apps/event-viewer/`);
they never ack and never affect processing. The topbar bell
(`src/components/desktop/EventBell.tsx`) shows the unread count. Full
reference: `docs/dev/events/events.md`.

---

### 14. Workflows — RETIRED from bos-core (042-workflow-manager-service)

**Stability: N/A — the bos-core engine has been retired**

The workflow engine that used to live at `src/lib/workflows/` (`store.ts`,
`runner.ts`, `generate.ts`, `validate.ts`, `types.ts`), its `api/workflows/`
routes, the `workflowTools()` server-tool set
(`src/lib/assistant/tools/server/workflows.ts`), the `<WorkflowActions/>`
frontend-tool bridge, and the 7 static `workflow_*` capability entries
have all been **deleted** as a user-approved engine pivot. Workflow
authoring/execution is being re-implemented as a **service-owned
marketplace item** (`data/user-apps/items/workflows/`, 039-service-tool-exposure
`deploymentMode: "tools"`) instead of bos-core, so the engine can evolve
(dynamic routing, parallel execution, ephemeral agents) without shadowing
service-declared tools. See
`specs/user-specs/workflow-manager/001-workflow-manager-service-tools/` for
the full spec, plan, and design of the replacement.

---

### 15. Dev Harness (`src/lib/devharness/`)

**Stability: MODERATE — tooling infrastructure**

| File | Responsibility |
|------|---------------|
| `supervisor.ts` | Supervisor integration |
| `repo-fs.ts` | Repository filesystem access |
| `dev/rep-fs.ts` | Source tree browsing for sub-agents |
| `dev/run-command.ts` | Sandboxed command execution |

**Security Model:** Source access restricted to active feature branches. VFS cannot see BOS source (strict isolation). Sandboxed command execution with configurable backends.

---

### 16. Deployment Infrastructure (`bastion/`, Dockerfile, docker-compose.yml)

**Stability: HIGH — infrastructure is stable**

**Bastion Architecture:**
```
Browser → bastion:80
  ├─ /app/login, /app/admin, /app/account → Vite SPA
  ├─ /login, /logout, /auth/* → Express auth routes
  ├─ /admin/* → Admin API
  ├─ /account/* → Self-service API
  └─ /** (authenticated) → Proxy → bos-{username}:8090
```

Per-user isolation: each user gets a dedicated Docker container with three volumes (src bind, data bind, node_modules named volume).

**Headless credential routing:** a request with no session cookie but a
parseable `Authorization: Basic` header is routed by
`bastion/src/credential-routing.ts`'s `resolveCredential()` — it hashes the
presented password and scans every provisioned user's
`data/system/credentials-index.json` (written by BOS's own
`src/lib/secrets/credentials-index.ts`, see §13.5), never by asking the
identity provider to resolve a username. `bastion/src/proxy.ts` rewrites a
match to `Authorization: Bearer <secret>` and proxies it exactly like a
session-based request; the target container's own `verifySecret()` remains
the sole authority on validity. See `docs/dev/features/headless-client-auth.md`.

---

## Dependency Graph

```
┌─────────────────────────────────────────────────────────────────┐
│                    Deployment Infrastructure                      │
│                 (bastion/, Dockerfile, Compose)                   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       API Routes Layer                            │
│             (src/app/api/*, *Actions.tsx, tool-manifest)          │
└─────────────────────────────────────────────────────────────────┘
         │           │           │           │           │
         ▼           ▼           ▼           ▼           ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│  Agent   │  │   Apps   │  │  Config  │  │  Memory  │  │  Skills  │
│  System  │  │  System  │  │  System  │  │  System  │  │  System  │
└──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
     │           │           │           │           │
     ▼           ▼           ▼           ▼           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    State Management Layer                         │
│                   (src/store/os-store.ts)                         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Storage Layer (VFS + GitFS + DataFS)             │
│            (src/os/vfs.ts, src/lib/gitfs/, src/lib/datafs/)       │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Core OS Layer                              │
│          (src/os/*.ts - types, data-dir, settings, apps)          │
└─────────────────────────────────────────────────────────────────┘
```

*(The API Routes row above omits two peers of similar shape for space: **Services
& Plugin Pipeline** — `src/core/service/`, `src/lib/plugins/` — sits alongside
Apps System, depending only on the Core OS Layer the same way Apps does.)*

**High-level layering (bottom-up):**
```
1. Core OS       — types, paths, VFS, settings (stable)
2. Storage       — VFS, GitFS, DataFS (stable-modern)
3. State         — Zustand store, window manager (moderate)
4. Config        — pluggable settings namespaces (moderate)
5. Infrastructure — MCP, Dev Harness, Integrations (moderate)
6. Apps          — built-in + installed app management (moderate)
6b. Services/Plugins — worker-thread daemons + agent-run hook pipeline (moderate)
7. Agent         — capabilities, memory, skills, sub-agents (evolving)
8. Specs         — pluggable spec-method pipeline (045: spec-kit is one descriptor among others)
10. API Routes   — thin delegates to above (moderate)
11. UI Shell     — Desktop, Windows, Dock (moderate)
12. Deployment   — bastion, Docker (stable)
```

