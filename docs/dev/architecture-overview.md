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

**Responsibilities:** Discover and manage installed apps. Built-in apps are React components discovered from `src/apps/`; installed apps are static HTML or esbuild-bundled projects served from GitFS as iframes.

**Dependencies:** `src/os/apps-dir.ts`, `src/lib/gitfs/store.ts`.
**Exposed Interfaces:** `listInstalledManifests()`, `installApp()`, `uninstallApp()`, `restoreApp()`, `purgeApp()`, `buildAppDir()`, `toManifest()`, `setAppCapabilities()`.

---

### 6. Configuration System (`src/lib/config/`)

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

### 7. Agent / Assistant System (`src/lib/agent/`)

**Stability: LOW — most rapidly evolving layer**

This is the most complex subsystem, with multiple sub-components:

#### 7.1 Core Agent Runtime
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

#### 7.2 Capabilities Registry
| File | Responsibility |
|------|---------------|
| `capabilities-registry.ts` | Unified capability definitions (80+ capabilities, 20+ groups) |

**Capability Groups:** OS, Web, Files, Config, Agents, Memory, Skills, Scratchpad, MCP, Apps, Dev, Docs, Workflows, Specs, Build Studio, Gmail, Google Drive, Google Calendar, Google Contacts, Telegram.

#### 7.3 Sub-agents (Delegation)
| File | Responsibility |
|------|---------------|
| `subagents/store.ts` | Agent definitions |
| `subagents/types.ts` | Agent type definitions |
| `subagents/runner.ts` | Sub-agent execution |
| `subagents/claude-runner.ts` | Claude Code runner |
| `subagents/tools.ts` | Sub-agent tool definitions |
| `subagents/markdown.ts` | Agent.md parsing |
| `subagent-events.ts` | Event streaming |

#### 7.4 Memory System
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

#### 7.5 Skills System
| File | Responsibility |
|------|---------------|
| `skills/store.ts` | Skill CRUD |
| `skills/improve.ts` | Skill improvement (GEPA) |
| `skills/curator.ts` | Skill curation and archiving |
| `skills/usage.ts` | Skill usage tracking |

#### 7.6 Compaction System
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

### 8. Specs System (`src/lib/specs/`, `src/lib/dev/spec-fs.ts`)

**Stability: LOW-MODERATE — pipeline is evolving**

| File | Responsibility |
|------|---------------|
| `stores.ts` | Spec store discovery |
| `store-git.ts` | Git operations for spec stores |
| `seed.ts` | Spec store seeding |
| `pipeline.ts` | Spec-kit pipeline orchestration |
| `types.ts` | Spec type definitions |
| `dev/spec-fs.ts` | Multi-root spec filesystem |

**Responsibilities:** External spec stores (system, user, marketplace), feature branch coupling, spec-kit pipeline (constitution → specify → clarify → plan → tasks → analyze → implement → converge), template system.

**Path Format:** `<storeId>/<relPath>` — e.g., `bos-system-specs/000-browseros-core/spec.md`.

---

### 9. MCP (`src/lib/mcp/`)

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

### 10. Desktop Shell (`src/components/desktop/`)

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

### 11. API Routes Layer (`src/app/api/`)

**Stability: MODERATE-HIGH — routes are thin delegates**

| Route | Delegates To |
|-------|-------------|
| `api/assistant/` | CopilotKit adapter, agent, title generation |
| `api/agent/` | Agent actions (reflect, discovery, feature branches) |
| `api/apps/` | Apps system |
| `api/config/` | Config system |
| `api/fs/` | VFS |
| `api/datafs/` | DataFS |
| `api/memory/` | Memory system |
| `api/skills/` | Skills system |
| `api/subagents/` | Sub-agents |
| `api/specs/` | Specs system |
| `api/workflows/` | Workflows system |
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

### 12. Integrations (`src/lib/integrations/`)

**Stability: MODERATE — adapters evolve with upstream APIs**

| File | Responsibility |
|------|---------------|
| `registry.ts` | Integration registry |
| `types.ts` | Integration type definitions |
| `actions/` | Action adapters (Gmail, Drive, Calendar, Contacts) |
| `adapters/` | OAuth flows, token management |
| `webhooks/` | Webhook handling |
| `notifications/` | Push notifications |
| `scheduler/` | Polling schedules |
| `state/` | Integration state management |
| `secrets/` | Client secret storage |

**Current Integrations:** Gmail, Google Drive, Google Calendar, Google Contacts, Telegram.

---

### 13. Workflows (`src/lib/workflows/`)

**Stability: LOW — execution engine is evolving**

| File | Responsibility |
|------|---------------|
| `store.ts` | Workflow CRUD |
| `runner.ts` | Workflow execution engine |
| `generate.ts` | Workflow generation from descriptions |
| `validate.ts` | DAG validation |
| `install.ts` | Workflow installation |
| `types.ts` | Workflow type definitions |
| `template/` | Workflow templates |

**Responsibilities:** Multi-step workflows as DAGs, step-by-step streaming execution, natural language generation, cancellation, status tracking.

---

### 14. Dev Harness (`src/lib/devharness/`)

**Stability: MODERATE — tooling infrastructure**

| File | Responsibility |
|------|---------------|
| `supervisor.ts` | Supervisor integration |
| `repo-fs.ts` | Repository filesystem access |
| `dev/rep-fs.ts` | Source tree browsing for sub-agents |
| `dev/run-command.ts` | Sandboxed command execution |

**Security Model:** Source access restricted to active feature branches. VFS cannot see BOS source (strict isolation). Sandboxed command execution with configurable backends.

---

### 15. Deployment Infrastructure (`bastion/`, Dockerfile, docker-compose.yml)

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

**High-level layering (bottom-up):**
```
1. Core OS       — types, paths, VFS, settings (stable)
2. Storage       — VFS, GitFS, DataFS (stable-modern)
3. State         — Zustand store, window manager (moderate)
4. Config        — pluggable settings namespaces (moderate)
5. Infrastructure — MCP, Dev Harness, Integrations (moderate)
6. Apps          — built-in + installed app management (moderate)
7. Agent         — capabilities, memory, skills, sub-agents (evolving)
8. Workflows     — DAG automation (evolving)
9. Specs         — spec-kit pipeline (evolving)
10. API Routes   — thin delegates to above (moderate)
11. UI Shell     — Desktop, Windows, Dock (moderate)
12. Deployment   — bastion, Docker (stable)
```

