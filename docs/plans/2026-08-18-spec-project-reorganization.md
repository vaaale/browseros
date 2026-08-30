# Project reorganization for the spec stores

**Status: executed** (2026-08-19). See "What actually happened" at the bottom
for the final state and where it deviates from this doc's original proposal.

037-project-layer wrapped all pre-existing content into two default catch-all
Projects during migration — `bos-system-specs/bos` and `user-specs/user` — so
nothing broke, but they're not meaningful groupings, just "everything that
existed before." This splits them into Projects that actually mean something:
a coherent area of BOS you'd activate and work on as a unit.

---

## `bos-system-specs` — proposed Projects

### `core-platform` — Core Platform & Shell
The baseline platform: the desktop shell, config system, and the small
platform-wide services everything else builds on.
- `000-browseros-core` — BrowserOS Core (Shell, Assistant, Configuration)
- `010-documentation` — Documentation Hub
- `017-central-logging` — Central Logging (timeline-first, Supervisor-collected)
- `026-plugin-pipeline` — Plugin Pipeline Architecture (hook-based plugin API, extracted from memory/compaction)
- `032-dynamic-integration-plugins` — BOS Plugin Infrastructure (broadened scope of the above, platform-wide)
- `031-setup-wizard` — Configuration Wizard (First-run Setup)

### `app-infrastructure` — App infrastructure
- `002-service-daemons` — Service Daemons
- `039-service-tool-exposure` — Service Tool Exposure

### `assistant` — Agent & Assistant Runtime
The agent loop itself: capabilities, delegation, tool taxonomy, and the
agent-facing capabilities that don't belong to a more specific area below.
- `004-browser-automation` — Browser Automation
- `011-per-agent-capabilities` — Per-Agent Capabilities (Tools, Skills, MCP)
- `012-embeddable-assistant` — Embeddable Assistant (Integration Plane)
- `014-mcp-tool-gateway` — MCP Tool Gateway (progressive disclosure)
- `016-unified-agents` — Unified Agent Model (a sub-agent is a role, not a type)
- `019-tools-and-sandbox` — Tool taxonomy, sandboxed command execution, per-conversation agents
- `025-agent-delegation-v2` — Agent Delegation v2 (unified registry, ephemeral agents, surface agents)
- `agent-settings-redesign` — Agent Settings Redesign

### `conversation-compaction` — Conversation Compaction
- `022-context-compaction` — Context Compaction (Layered Conversation Compactification)

### `memory` — Memory System
- `002-memory` — Memory System (storage substrate)
- `021-memory-loops` — Memory Loops (Episodic Fast Loop & Consolidating Slow Loop)
- `023-memory-app` — Memory App Redesign
- `027-memory-scheduler-migration` — Memory Scheduler Migration to Plugin System
- ~~`memory-app-redesign`~~ — **stale duplicate of `023-memory-app`** (see Anomalies below); recommend deleting rather than moving

### `build-studio` — Build Studio & Spec-Kit
Spec-kit authoring itself, and the store/branch machinery underneath it —
including this very feature.
- `001-build-studio` — Build Studio
- `013-build-studio-agentic` — Build Studio — Agentic Studio (idea → built feature)
- `018-external-spec-store` — External Spec Stores (System + User)
- `020-branch-coupled-specs` — Branch-Coupled Spec Provisioning
- `027-vfs-specfs-marketplace` — User-Spec Relocation (VFS mounts, SpecFS, Feature Context, Spec Provider Registry) — despite "marketplace" in the old branch name, the marketplace/sandbox work was split out to `028` early on; this one is pure spec-store plumbing
- `037-project-layer` — Projects (this feature)

### `self-modification` — Self-Modification & Dev Harness
How BOS edits and tests itself: preview branches, data isolation, versioned
content, and the harness settings that configure it.
- `003-self-improvement` — Self-Improvement (Learning Loop & Skill Lifecycle)
- `005-self-modification` — Self-Modification (Live Version Control)
- `006-data-isolation` — Data Isolation (DataFS)
- `008-self-testing` — Self-Testing (Playwright Verify Stage)
- `029-settings-dev-harness` — Settings — Dev Harness (credentials, provider & MCP servers)
- `030-settings-mcp-servers` — Settings — MCP Servers (configuration)

### `filesystems` — Filesystems
- `007-gitfs` — GitFS (Versioned Content Layer)


### `marketplace` — Marketplace & Installed Apps
The three-source app model and how items get installed/built.
- `009-installed-apps` — Installed Apps (Buildable App Projects)
- `028-marketplace-sandbox` — Marketplace + Sandboxed Apps (Three-Source App Model, Opaque-Origin Sandbox, iframe SDK)
- `034-user-apps-marketplace-parity` — user-apps is a Marketplace (Layout & Manifest Parity)
- `035-install-by-symlink` — Install Is a Symlink (One Item, One Link, No Copies)

### `multi-user` — Multi-User & Deployment
Running BOS for more than one person: the Bastion, container lifecycle, and
the auth/secrets plumbing that spans standalone and multi-user deployments.
- `024-docker-multiuser` — Docker Multi-User Deployment (Bastion + Dynamic Instances)
- `026-multiuser-usability` — Multi-User Usability (First-run, Admin Portal, Account UX, Container-native run_command & Harness Auth)
- `034-secrets-authentication` — Generic Service Secrets & Bastion Credential Routing

### `voice` — Voice & Presence
- `033-pluggable-voice-engines` — Pluggable Voice Engines
- `036-embodied-presence` — Embodied Presence (A Voice Engine With a Face)

### `agentic-text-editor` — Agentic Text Editor
- `agentic-text-editor` — Agentic Text Editor

### `lunar-lander` — Lunar Lander Game
- `lunar-lander` — Lunar Lander Game

### `builtin-apps` — Built-in Apps & Utilities
Standalone built-in apps that aren't platform infrastructure — each is its
own self-contained feature, grouped here because none is big enough alone
to warrant its own Project (a real candidate to split further later if any
one of these grows a lot of follow-up work).
- `html-viewer` — HTML Viewer (System Component)
- `scheduler` — Scheduler (Task Scheduling Daemon & UI)
- `scratchpad` — Scratchpad (Conversation-Scoped Note-Taking)

### `integrations` — External Integrations
Third-party service connectors.
- `001-external-repo-integration` — External Repository Integration (this is the **canonical, current** version — see Anomalies)
- `integrations-framework` — Integration Framework

### `gsuite` — GSuite Integration
- `gsuite-integration` — GSuite Integration
- `google-photos-integration` — Google Photos Integration

### `telegram` — Telegram Integrations
- `telegram-integration` — Telegram Integration


**Total: 52 features across 18 Projects** — see "What actually happened" below
for the final count once `agentic-text-editor` moved to its marketplace item
and the two duplicates were deleted.

---

## `user-specs`

Superseded by the "marketplace items must be moved into user-apps" rule
(see "What actually happened" below) — nothing here ended up as a `user-specs`
Project. `user-specs/user` is now empty (kept as the default landing spot for
future non-marketplace-item work).

---

## Anomalies found while reading every spec (worth fixing regardless of the reorg)

1. **`023-memory-app` vs. `memory-app-redesign`** (`bos-system-specs`) are
   near-identical specs — `023-memory-app` is the later, more complete
   version (adds FR-005 through FR-009, and says the old Memory app UI is
   "completely replaced" rather than just "redesigned"). `memory-app-redesign`
   reads like an earlier draft that got renumbered to `023` and never deleted.
   Recommend deleting `memory-app-redesign` rather than moving it into a
   Project.

2. **`001-external-repo-integration` exists in both stores with diverged
   content.** The `bos-system-specs` copy is the current one — it has a
   whole extra section (User Story 6, "Automated Conflict Resolution via
   DevOps Agent") describing a shared reconciliation pipeline that replaced
   the older per-surface confirm-dialog design still described in the
   `user-specs` copy. The `user-specs` copy looks like a stale fork from
   before that redesign. Recommend deleting the `user-specs` copy rather
   than moving it.

3. **`021-memory-loops` and `022-context-compaction`** don't have a file
   named `spec.md` — theirs are named `021-memory-loops-spec.md` and
   `022-context-compaction-spec.md` respectively. Since 037-project-layer's
   "a directory is a feature leaf iff it directly contains `spec.md`" rule
   is literal, **these two directories aren't currently recognized as
   feature leaves at all** — they won't show up correctly in Build Studio's
   tree or pipeline-status view. Recommend renaming both files to `spec.md`
   (independent of the Project reorg, and worth doing before or during it).

---

## What actually happened

Executed directly against `data/specs/*` and `data/user-apps` with plain git
operations (not through Build Studio's UI/API — this is a one-time bulk
reorganization, not the kind of incremental edit the Project-session
git workflow is for), one commit per repo. Two rules from the user, on top of
this doc's original proposal, changed the final shape:

1. **Every app gets its own Project.** `agentic-text-editor` and
   `lunar-lander` split out of the original `builtin-apps` catch-all; so did
   `html-viewer`, `scheduler`, and `scratchpad`, dissolving `builtin-apps`
   entirely. `html-viewer` keeps its own Project rather than merging with
   anything, pending a separate future plan to merge it with the `ui-preview`
   app.
2. **Marketplace items move into `user-apps`, not a Project.** Any spec whose
   `App Target` is `marketplace-item` (or that's empirically already an
   installed item under `data/user-apps/items/`) moved to that item's own
   `spec/` folder — the item-owned spec store model (034/035), which sits
   outside the Project layer entirely, not another kind of Project. This
   caught four specs that were still centralized despite belonging to real
   items: `agentic-text-editor` (bos-system-specs), and `037-webdav-vfs-mount`
   / `038-knowledge-base` / `040-okf-knowledge-base` (user-specs) — the latter
   three are why `user-specs` ended up with no Projects of its own beyond the
   now-empty default `user`. `040-okf-knowledge-base`'s bundled `e2e/` test
   went to the item's own top-level `e2e/` (sibling to `spec/`), matching
   `agentic-text-editor`'s existing layout, not into `spec/` itself. Two
   stale path references left over from before the move were fixed in the
   same commit (`knowledge-base`'s README, `agentic-text-editor`'s e2e test
   comment).

The three anomalies were resolved as recommended: `memory-app-redesign` and
the `user-specs` copy of `001-external-repo-integration` were deleted (not
moved), and `021-memory-loops-spec.md` / `022-context-compaction-spec.md`
were renamed to `spec.md`. One more anomaly turned up while investigating the
marketplace-item moves: `036-embodied-presence` (bos-system-specs) was a
stale, less-complete draft of the `live-avatar` item's own already-migrated
`spec/spec.md` — deleted for the same reason as the other two duplicates.

Final `bos-system-specs` shape — 17 Projects (originally 18; `lunar-lander`
later removed, see addendum below): `core-platform` (renamed from `bos`),
`app-infrastructure` (gained `002-service-daemons` and
`039-service-tool-exposure` from `user-specs` — BOS-wide service
infrastructure, not user-specific), `assistant`, `conversation-compaction`,
`memory`, `build-studio`, `self-modification`, `filesystems`, `marketplace`,
`multi-user`, `voice`, `html-viewer`, `scheduler`, `scratchpad`,
`integrations`, `gsuite`, `telegram` — 50 features total (52 original, minus
`agentic-text-editor` and `lunar-lander` moved to their items, minus
`memory-app-redesign` deleted, plus the 2 moved in from `user-specs`).

**A real bug turned up executing this**: `migrateToDefaultProject()`
(`src/lib/specs/seed.ts`) decided "this store needs migrating" purely from
"is there a top-level entry not literally named `bos`/`user`" — so this
exact reorganization would have looked identical to "never migrated" and
gotten silently re-wrapped into a fresh `bos`/`user` directory on the next
server start, undoing all of it. Fixed to detect any existing Project (a
top-level dir owning a `project.json`) regardless of name, with a regression
test (`tests/specs/project-layer.test.ts`) — see that commit on
`bos/item-owned-specs` for details.

## Addendum: the central marketplace (`bos-marketplace`) is these items' only home

`data/user-apps` is the user's own **private** marketplace; `bos-marketplace`
(a separate git repo, sibling to this one, not under `data/` at all) is the
**central** one several items actually originate from. Three items —
`agentic-text-editor`, `webdav-vfs-mount`, `live-avatar` — existed as
byte-identical duplicates in both (`diff -rq` found zero differences aside
from one item's local-only test files). An app belongs in exactly one place,
so rather than picking a location for just their specs, all three were
**removed from `data/user-apps` entirely** and now live solely in
`bos-marketplace`.

This also surfaced a spec the original pass never had a home for:
`lunar-lander` — a real, fully-implemented item (`items/lunar-lander/app/`,
several hundred lines across game engine/physics/rendering) that has only
ever existed in `bos-marketplace`, never adopted into `data/user-apps`. Its
spec had been sitting as a standalone Project in `bos-system-specs` with no
corresponding code anywhere in the BOS repo or `data/user-apps` — an artifact
of never having checked the central marketplace during the original audit,
since nothing in either BOS store pointed at it.

Resolution (separate commits, one per repo):
- `bos-marketplace`: added `items/{agentic-text-editor,webdav-vfs-mount,lunar-lander}/spec/`
  (the first two moved from `data/user-apps`; `lunar-lander`'s moved from its
  `bos-system-specs` Project) and `items/agentic-text-editor/{e2e/,playwright.config.ts}`
  (its only test coverage, previously local-only — that config file's own
  header comment already described this exact convention: "the item bundles
  its own e2e coverage... see bos-marketplace's README/CONTRIBUTING once
  this is written up").
- `bos-system-specs`: removed the `lunar-lander` Project entirely (down to
  17 Projects, 50 features).
- `data/user-apps`: removed `items/{agentic-text-editor,webdav-vfs-mount,live-avatar}/`
  entirely and their three entries in `marketplace.json` — none had an active
  `data/system/<id>` install symlink, so nothing was relying on the local
  copy at runtime. `knowledge-base`/`okf-knowledge-base` (genuinely private,
  not in `bos-marketplace`) are untouched.

Not re-audited for other names beyond confirmed matches: `bos-marketplace`
also has `bos-app-starter`, `color-palette`, `pomodoro`, `terminal`,
`unit-converter`, `welcome`, `workflows` — none matched any spec title in
either BOS store, so presumably always had their specs authored directly
in `bos-marketplace` (or never had a centralized spec to begin with).
