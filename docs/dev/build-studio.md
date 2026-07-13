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
  the stores. Paths are STORE-PREFIXED `<storeId>/<rel>`; reads span all stores, writes are
  refused for read-only stores and commit-on-save to the store's checked-out branch
  (base: the default branch; preview: the feature branch). `readFileAt(path, branch)`
  reads a draft branch. The spec-kit engine (templates/commands) stays in source and is
  read via `readTemplate`/`listTemplates`. It cannot reach BOS source or secrets.
- **Spec model** — `src/lib/specs/types.ts` (framework-free) and
  `src/lib/specs/pipeline.ts` (iterates stores; derives per-feature pipeline status, parses
  `tasks.md` progress, and `nextFeatureId()` for `NNN-slug` numbering within a store).
- **Tools** — `spec_list`/`spec_read`/`spec_write`/`spec_edit`/`spec_search`/
  `spec_template_read`/`spec_template_list`, natively implemented in
  `src/lib/assistant/tools/server/specs.ts` (over `specfs` directly — the old
  `SPEC_TOOLS`/`subagents/tools.ts` indirection was retired,
  025-agent-delegation-v2), opt-in like any other registry tool. Each call
  resolves the active feature branch per-conversation
  (`getConversationActiveFeatureBranch(ctx.conversationId)`). Plus
  `dev_delegate` (`src/lib/assistant/tools/server/dev-delegate.ts`), built
  per-run so it forwards the parent event stream (nested-agent UI) and guards
  nesting depth — see [Sub-agents & delegation](assistant/sub-agents-and-delegation.md).
- **Agent** — seeded in `subagents/store.ts` `DEFAULTS` (local; thin prompt;
  `tools` = spec tools + `delegate_to_developer`). Back-filled additively on upgraded
  installs (only when missing).
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
- **Agent app-control tools** — `src/apps/build-studio/AgentTools.tsx` registers
  `openSpecArtifact` (show an artifact in the centre viewer) and `refreshSpecTree`
  (reload the tree) as `useCopilotAction` frontend tools. They are passed through
  `AssistantChat`'s `children` slot so they mount **inside the chat's CopilotKit provider**
  and are therefore callable by the build-studio agent (and only when the app is open).
  These are frontend UI-control actions — **distinct from `SPEC_TOOLS`**, the server-side
  file tools the sub-agent uses to read/write the spec stores.

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
