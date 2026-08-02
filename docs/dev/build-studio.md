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
- **Branch-coupled drafts** (020) — feature work happens on `bos/*` branches shared
  with the BOS repo: the Supervisor mounts each store into the preview worktree as a
  git worktree on the feature branch; promote/discard of specs rides the code
  promote/discard (see `self-modification/live-version-control.md`). The old global
  `spec-candidate` branch is retired. Base renders drafts read-only from the store
  refs (no checkout) as branch-badged nodes in the spec tree.
- **Spec jail** — `src/lib/dev/spec-fs.ts`: MULTI-ROOT `list/read/write/edit/search` over
  the stores, still used by the Build Studio **app**'s own `/api/specs` route (the
  three-pane UI's tree/viewer). Paths are STORE-PREFIXED `<storeId>/<rel>`; reads span all
  stores, writes are refused for read-only stores and commit-on-save to the store's
  checked-out branch (base: the default branch; preview: the feature branch).
  `readFileAt(path, branch)` reads a draft branch. The spec-kit engine (templates/commands)
  stays in source and is read via `readTemplate`/`listTemplates`. It cannot reach BOS
  source or secrets. **Agent tool calls no longer go through this file** — they use the
  generic `file_*` tools against the VFS mounts registered in
  `src/lib/specs/spec-mount.ts` (`SpecFS` from `src/os/fs/spec-fs.ts`, a separate module):
  `/Specs/user-specs`, `/Specs/bos-system-specs` (writable, branch-coupled), `/Templates`
  (read-only), `/Docs` (writable, branch-coupled, backs `docs/`).
- **Spec model** — `src/lib/specs/types.ts` (framework-free) and
  `src/lib/specs/pipeline.ts` (iterates stores; derives per-feature pipeline status, parses
  `tasks.md` progress, and `nextFeatureId()` for `NNN-slug` numbering within a store).
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
- **API** — `src/app/api/specs/route.ts`: `GET` groups(stores)+status / artifact (store-prefixed
  `path`, optional `branch` for read-only draft reads), `PUT` artifact (atomic). No POST:
  spec promotion is branch-coupled to the code promote (020). Server-only; the app talks
  to it over `fetch`.
- **App** — `src/apps/build-studio/` (`manifest.ts` + `index.tsx`): a three-pane layout —
  spec tree (left) + pipeline strip & artifact view/edit (centre) + the embedded
  **agent chat** (right, `<AssistantChat agentId={buildStudioAgent}>`, per `012`/`013`).
  The agent is user-configurable in **Settings → Build Studio** (defaults to the
  `"build-studio"` agent); the app reads it from `GET /api/config/build-studio` on mount.
  The two side panes are resizable via `src/components/apps/ResizeHandle.tsx`
  (widths persisted in `localStorage`).
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

See `specs/001-build-studio/` for the spec/plan/tasks that drove this feature.
