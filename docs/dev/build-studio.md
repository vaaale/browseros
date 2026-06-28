# Build Studio (spec-kit subsystem)

Build Studio adds spec-driven development to BOS. It is assembled from existing
primitives (a sub-agent, a skill, a built-in app, one API route) plus a spec-scoped
filesystem jail. It writes no source itself — implementation is delegated to the
Developer.

## Pieces

- **Spec jail** — `src/lib/dev/spec-fs.ts`: `list/read/write/edit/search` confined to
  `specs/` and `.specify/`, atomic writes. Like `repo-fs.ts` but far narrower; it cannot
  reach BOS source or secrets.
- **Spec model** — `src/lib/specs/types.ts` (framework-free) and
  `src/lib/specs/pipeline.ts` (derives per-feature pipeline status, parses `tasks.md`
  progress, and `nextFeatureId()` for `NNN-slug` numbering).
- **Tools** — `SPEC_TOOLS` (`list_specs/read_spec/write_spec/edit_spec/search_specs`) in
  `src/lib/agent/subagents/tools.ts`, opt-in like `DEV_TOOLS`. Plus `delegate_to_developer`,
  built per-run in `runLocal` (`subagents/runner.ts`) so it forwards the parent event
  stream (nested-agent UI) and guards nesting depth.
- **Agent** — seeded in `subagents/store.ts` `DEFAULTS` (local; thin prompt;
  `tools` = spec tools + `delegate_to_developer`). Back-filled additively on upgraded
  installs (only when missing).
- **Skill** — the "Build Studio" driver skill seeded in `skills/store.ts` `SEED`
  (`SKILL.md` triage + a reference per spec-kit step). **This is the extension point**:
  add references or companion skills. An external integration (e.g. a future GitLab
  integration) needs BOTH a skill (instructions) and a tool/MCP (the capability).
- **API** — `src/app/api/specs/route.ts`: `GET` tree+status / artifact, `PUT` artifact
  (atomic). Server-only; the app talks to it over `fetch`.
- **App** — `src/apps/build-studio/` (`manifest.ts` + `index.tsx`): spec tree +
  pipeline strip + artifact view/edit.

## Conventions

- spec-kit is vendored under `.specify/` (templates, command prompts, scripts); the
  constitution is `.specify/memory/constitution.md`.
- `implement` is ALWAYS a delegation to the Developer (Claude) — Build Studio never edits
  `src/`.
- Specs are repo content under `specs/`, versioned with BOS (distinct from installed-app
  content, which lives in GitFS).
- The legacy prose specs under `spec/` (singular) were migrated to `specs/`
  (spec-kit); the original prose remains in git history.

See `specs/001-build-studio/` for the spec/plan/tasks that drove this feature.
