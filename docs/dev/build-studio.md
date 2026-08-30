# Build Studio (spec-kit subsystem)

Build Studio adds spec-driven development to BOS. It is assembled from existing
primitives (a sub-agent, a skill, a built-in app, one API route) plus a spec-scoped
filesystem jail. It writes no source itself — implementation is delegated to the
Developer.

## Pieces

- **Spec stores** (018/020) — specs live in external git repos under `BOS_SPECS_ROOT`
  (default `/specs`, gitignored), each a self-describing folder (git repo + `spec-store.json`
  manifest declaring `owner`/`writable`/`requiresPromote` — the latter retained as metadata).
  Discovery + manifest: `src/lib/specs/stores.ts`; container config `src/os/specs-dir.ts`;
  seeding (system store from `seed/spec-store/`, additive; skipped when `BOS_SPECS_SEED=0` —
  previews) `src/lib/specs/seed.ts`; commit-on-save + draft-branch reads (list/diff/`git show`)
  `src/lib/specs/store-git.ts`.
- **Project layer** (037) — every directory-scanned store (`system`/`user`/`marketplace`
  owner, never `item`) is organized into **Projects**, `<store>/<project-id>/...`, with
  arbitrary plain sub-folders allowed below a Project; a directory is a feature leaf iff it
  directly contains `spec.md` (`src/lib/specs/projects.ts`: `listProjects`/`getProject`/
  `createProject`/`isFeatureLeaf`). `seed.ts`'s `migrateToDefaultProject()` wraps
  pre-existing flat content into a default "BOS"/"User" Project once, idempotently. A
  Project is a pure organizational folder with no git-activation of its own — an earlier
  design (`project-git.ts`/`project-sessions.ts`, a lightweight per-Project git-worktree
  flow) was retired in favor of two PRE-EXISTING mechanisms, reused instead of invented:
  - `bos-system-specs` is **read-only, unconditionally** — the specs BOS ships with; never
    editable here, branch or not (see "Spec jail" below).
  - `user-specs` — a user's own customizations to BOS core (including built-in apps) — is
    writable only on a real `bos/*` feature branch, the SAME branch used for BOS's own
    source code. Build Studio reads it directly from this window's own embedded chat
    conversation (`useActiveConversation(buildStudioAgent)`, `src/lib/agent/conversations.ts`)
    — the exact "Active feature branch" dropdown already rendered in that chat pane
    (`FeatureBranchSelector`, `src/components/apps/assistant/AgentSelector.tsx`); no separate
    Build Studio branch picker exists. The whole store's write-availability is shown as one
    badge next to its group header (`data-testid="user-specs-branch-badge"`), not per-Project.
- **Item-owned stores are branch-coupled too** — an `owner: "item"` store (an installed
  marketplace item's own `spec/` folder, `item-stores.ts`) has no Project of its own, and
  no activation state of its own either. Its content lives in `data/user-apps`, which the
  Supervisor mounts as a worktree on the active `bos/*` feature branch (`coupled-repos.mjs`'s
  `coupledReposFor`), so an item's spec travels with its app/service code AND with BOS's
  own source, and promotes or discards as ONE operation. Writes therefore require the same
  active feature branch every other writable store does (`spec-fs.ts`'s `prepareWrite`,
  unconditional — only branch ROUTING is Supervisor-conditional), and the elicitation the
  agent hits is the same `dev_branch_request` one. Because `user-apps` is a different repo
  from the `<codeWorktree>/specs/<storeId>` mounts, item stores get their own resolver
  (`branchItemStoreRoot` → `<previewDataDir>/user-apps/items/<id>/spec`) — a path difference,
  not a policy difference. History and `git show <ref>:<path>` go through `store.repoRoot`
  (the `user-apps` repo) + `storeRepoRelative()`, never the store root, which has no `.git`
  of its own. The Supervisor's global **app-candidate** branch — a second, in-place branch
  scheme over the same repo, with its own per-item Activate/Promote/Discard row in this app
  and "Promote app"/"Discard app" buttons in `VersionControls.tsx` — is **retired**.
- **Branch-coupled drafts** (020) — feature work happens on `bos/*` branches shared
  with the BOS repo: the Supervisor mounts each store into the preview worktree as a
  git worktree on the feature branch; promote/discard of specs rides the code
  promote/discard (see `self-modification/live-version-control.md`). The old global
  `spec-candidate` branch is retired. Base renders drafts read-only from the store
  refs (no checkout) as branch-badged nodes in the spec tree.
- **Spec jail** — `src/lib/dev/spec-fs.ts`: MULTI-ROOT `list/read/write/edit/search` over
  the stores, still used by the Build Studio **app**'s own `/api/specs` route (the
  three-pane UI's tree/viewer, plus `DELETE`/`PATCH` for file remove/rename). Paths are
  STORE-PREFIXED `<storeId>/<rel>`; reads span all stores. `prepareWrite()` refuses a
  non-writable store outright (`bos-system-specs`, unconditionally — branch or not), then
  requires an explicit `ctx.branch` (the real `bos/*` feature branch) for every other
  directory-scanned store, plus a path inside a Project (creating a Project's own
  `project.json` is exempt — bootstrapping a folder shouldn't need a branch selected
  first). Item-owned stores are exempt from both checks — writes go straight through
  (`commitScoped`), riding whatever branch `data/user-apps` currently has checked out.
  `ctx.branch` resolves to a LIVE, writable worktree via `branchSpecsRoot`/`supervisorBegin`
  — distinct from `readFileAt(path, branch)`, which reads a READ-ONLY draft branch (020,
  `git show`, no checkout); `/api/specs`'s GET route exposes the live path as a separate
  `liveBranch` query param so the two are never confused. `readFileAtRef`/`resolveStoreRoot`
  (037) support cross-branch history browsing independent of either. The spec-kit engine
  (templates/commands) stays in source and is read via `readTemplate`/`listTemplates`. It
  cannot reach BOS source or secrets. **Agent tool calls no longer go through this file**
  — they use the generic `file_*` tools against the VFS mounts registered in
  `src/lib/specs/spec-mount.ts` (`SpecFS` from `src/os/fs/spec-fs.ts`, a SEPARATE
  implementation with the same branch-coupled routing, plus its OWN `writable` gate on
  `requireWriteBackend()` — closed during this redesign: it previously had no writable
  check at all, so the agent's `file_write` could write to `bos-system-specs` whenever a
  feature branch was active, despite the app's own `/api/specs` route already refusing
  it): `/Specs/user-specs` (writable, branch-coupled), `/Specs/bos-system-specs`
  (**read-only**), `/Templates` (read-only), `/Docs` (writable, branch-coupled, backs
  `docs/`).
- **Spec model** — `src/lib/specs/types.ts` (framework-free) and
  `src/lib/specs/pipeline.ts` (recursively walks store → Project → arbitrary plain
  sub-folders → feature leaf, i.e. any directory directly containing `spec.md`; derives
  per-feature pipeline status, parses `tasks.md` progress, and `nextFeatureId(name,
  projectPath)` for `NNN-slug` numbering scoped to ONE Project, not the whole store).
- **History** — `src/app/api/specs/history/route.ts`: list every commit that touched a
  path (`gitfs/store.ts`'s `history({all: true})`, spans every branch) and read/restore any
  version by ref (`readFileAtRef` + a normal `writeFile`, so restoring is a new commit, not
  a hard reset). The GET side has no writability/branch gate of its own (read-only,
  needs neither); restore (`POST`) is gated the same as any other write. Surfaced in Build
  Studio's `HistoryDialog.tsx` via a file's right-click menu — which, per the store-level
  `writable` gate, never renders at all for a `bos-system-specs` file (right-clicking a
  system spec does nothing, not even a disabled "View history").
- **Tools** — the dedicated `spec_*`/`docs_*` tool family (previously
  `src/lib/assistant/tools/server/specs.ts`) has been retired and folded into the
  generic `file_list`/`file_read`/`file_write`/`file_edit`/`file_patch`/`file_search`/
  `file_glob` tools (`src/lib/assistant/tools/server/files.ts`), with branch-coupling
  and store routing delegated to the VFS mounts (`src/lib/specs/spec-mount.ts`) instead
  of tool-layer special-casing — `specs.ts` is now an empty stub kept only as a
  breadcrumb. Build Studio reaches specs/docs/templates through these `file_*` tools at
  `/Specs/<store>/...`, `/Docs/...`, `/Templates/...` like any other VFS path. Plus
  `dev_delegate` (`src/lib/assistant/tools/server/dev-delegate.ts`), built
  per-run so it forwards the parent event stream (nested-agent UI) and guards
  nesting depth — see [Sub-agents & delegation](assistant/sub-agents-and-delegation.md).
- **Agent** — seeded from `seed/agents/build-studio/AGENT.md` by
  `src/lib/agent/subagents/store.ts` (local; thin prompt; `tools` = `file_*` scoped to
  `/Specs`/`/Templates`/`/Docs` + `dev_delegate` + the `buildstudio_*` viewer tools).
  Back-filled additively on upgraded installs (only when the agent's `data/agents/<id>/`
  file is missing — an existing file is never overwritten, so a stale local copy needs a
  manual fix).
- **Skill** — the "Build Studio" driver skill seeded in `skills/store.ts` `SEED`
  (`SKILL.md` triage + a reference per spec-kit step). **This is the extension point**:
  add references or companion skills. An external integration (e.g. a future GitLab
  integration) needs BOTH a skill (instructions) and a tool/MCP (the capability).
- **API** — `src/app/api/specs/route.ts`: `GET` groups(stores)+status / artifact
  (store-prefixed `path`, optional `branch` for a read-only draft read or `liveBranch` for
  a real, writable branch's mount), `PUT`/`DELETE`/`PATCH` all accept an optional `branch`
  for the same live-branch write path. No POST: spec promotion is branch-coupled to the
  code promote (020). Server-only; the app talks to it over `fetch`.
- **App** — `src/apps/build-studio/` (`manifest.ts` + `index.tsx`): a three-pane layout —
  spec tree (left) + pipeline strip & artifact view/edit (centre) + the embedded
  **agent chat** (right, `<AssistantChat agentId={buildStudioAgent}>`, per `012`/`013`).
  The agent is user-configurable in **Settings → Build Studio** (defaults to the
  `"build-studio"` agent); the app reads it from `GET /api/config/build-studio` on mount.
  The two side panes are resizable via `src/components/apps/ResizeHandle.tsx`
  (widths persisted in `localStorage`). `ResizeHandle` is a **system-level**
  component (any app can use it, not just Build Studio) with a drag-session
  contract every consumer inherits for free: the initiating pointer is
  captured on press (so the drag survives the pointer crossing an embedded
  iframe, e.g. an HTML mockup in the centre viewer), the session ends exactly
  once on either pointerup or pointercancel with identical cleanup, events
  from any other pointer are ignored, and width updates are coalesced to one
  per animation frame — see the component's own header comment and
  `resize-handle-session.ts` (the pure, unit-tested state machine backing it)
  for the full contract (033-fix-pane-resize). The right (chat) pane's
  maximum width is viewport-aware, not a fixed constant: it's computed from
  the app root's measured content width minus the left pane's minimum and a
  center-viewer floor (see `CENTER_MIN_FLOOR` in `src/apps/build-studio/index.tsx`),
  and a persisted width outside the current valid range is re-clamped on load
  or window resize.
- **Agent app-control tools** — `src/apps/build-studio/agent-tools-v2.ts` declares
  `buildstudio_artifact_open` (show an artifact in the centre viewer — opens it but
  returns no content), `buildstudio_artifact_highlight` (scroll/highlight a heading
  anchor in the open artifact), `buildstudio_tree_refresh` (reload the tree), and
  `buildstudio_run_tests` as surface tools for the v2 embeddable Assistant; they mount
  while the app is open and are registered as capabilities in
  `src/lib/agent/capabilities-registry.ts`. `AgentTools.tsx` (`openSpecArtifact`/
  `refreshSpecTree` as `useCopilotAction`) is the equivalent for the retired CopilotKit
  chat path. Either way, these are frontend UI-control actions only — **distinct from
  the `file_*` tools** the agent uses to actually read/write spec content; opening an
  artifact in the viewer does not put its text into the agent's context, so always pair
  `buildstudio_artifact_open` with a `file_read` on the `/Specs/...`-prefixed path.

## The conflict pane (035)

Build Studio is also where a **git merge conflict** gets resolved — in any repo BOS
manages, not just the spec stores. When the reconciliation pipeline can't resolve a
conflict deterministically it escalates, and BS opens **by itself**: the topbar
subscriber (`src/components/desktop/ConflictLaunch.tsx`) launches this app with
`{ pane: "conflict", sessionId }` on the `com.bos.gitops.conflict.escalated` event,
which BS declares a UI handler for in its manifest.

While a session is active the pane **replaces the centre artifact viewer** (the left
spec tree stays for context) and the **existing right-hand chat** is re-pointed at the
session's conversation. That chat is the agent↔user channel — there is no second chat.
When the session goes terminal the centre reverts to the viewer.

The pane (`src/apps/build-studio/conflict/`) shows the status pill, the repo / branch /
rollback tag, the per-file decision chips, the conflicting-file rail, and a three-way
view (unified-with-markers, or 3-way columns) of the selected file. When the agent
parks on a question, the file it's waiting on goes amber in four places at once — the
pill, a banner over the file, the file row, and the decision card in the chat — and the
per-hunk controls (accept ours / theirs / keep both / edit manually / accept the agent's
suggestion) unlock. Answering from the pane and answering from the chat are the same
request. "Abandon & roll back" is available at any point and restores the repo to its
pre-reconciliation tag.

A browser refresh restores the pane: BS re-queries the session store on mount rather
than relying on the event.

**Settings → Build Studio** has a second dropdown, **Conflict agent**
(`build-studio.conflictAgent`, default `devops`), for which agent does this work. It is
read on every escalation, so a change takes effect immediately. The agent you pick must
have the `conflict_*` tools in its allowlist — the dropdown says so when it doesn't.

Full architecture: [`features/git-conflict-resolution.md`](features/git-conflict-resolution.md).

## Conventions

- spec-kit's ENGINE is vendored under `.specify/templates` (templates, command prompts) +
  `.specify/scripts` and stays in BOS source; the **constitution** is spec CONTENT and lives
  in the system store at `bos-system-specs/.specify/memory/constitution.md`.
- `implement` is ALWAYS a delegation to the Developer (Claude) — Build Studio never edits
  `src/`.
- Specs are repo content under `specs/`, versioned with BOS (distinct from installed-app
  content, which lives in GitFS).
- The legacy prose specs under `spec/` (singular) were migrated to `specs/`
  (spec-kit); the original prose remains in git history.

See `bos-system-specs/build-studio/001-build-studio/` for the spec/plan/tasks that drove this
feature (and `bos-system-specs/build-studio/037-project-layer/` for the Project layer itself).
