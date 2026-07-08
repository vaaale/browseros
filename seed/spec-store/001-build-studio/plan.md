# Implementation Plan: Build Studio

**Branch**: `001-build-studio` | **Date**: 2026-06-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-build-studio/spec.md`

## Summary

Build Studio adds a Software-As-A-Prompt authoring layer to BOS: a local "Build Studio"
agent that drives the spec-kit pipeline over `specs/`, plus a companion app (spec tree +
pipeline visualization). Authoring uses new spec-scoped tools and spec-kit skills;
implementation is delegated to the existing Developer (Claude) sub-agent. Build Studio
itself gains no source-writing capability.

## Technical Context

**Language/Version**: TypeScript — Next.js (App Router), React, Node ≥ 20 (matches BOS).

**Primary Dependencies**: Next.js, React, Zustand, CopilotKit; existing BOS subsystems
(sub-agents, skills, config registry, `atomic-write`, dev harness). No new runtime deps.

**Storage**: Filesystem. Specs under `specs/` (repo, versioned). spec-kit assets under
`.specify/`. Agent/skill seeds materialize under `data/` at runtime.

**Testing**: Playwright e2e (BOS convention) for the app; a unit/contract test for the
spec-fs jail and pipeline-status derivation.

**Target Platform**: BOS (SSR web app) running under the self-modification supervisor.

**Project Type**: Web — single Next.js project (the BOS repo).

**Performance Goals**: Spec tree + artifact reads are local fs; render < 100 ms for
typical trees (≤ a few hundred files). No heavy compute.

**Constraints**: Server/client boundary (spec fs is server-only behind `/api/specs`);
spec tools jailed to `specs/` + `.specify/`; Build Studio never writes source.

**Scale/Scope**: Tens of features × a handful of artifacts each. v1 commands:
constitution, specify, clarify, plan, tasks, analyze, implement, converge.

## Constitution Check

*GATE: must pass before design; re-check after.*

- **I. Spec-Driven**: this feature is itself spec-first (this plan derives from `spec.md`); Build Studio operationalizes the principle. PASS.
- **II. Server boundary**: spec filesystem access is server-only (`src/lib/specs/*`, `src/lib/dev/spec-fs.ts`) behind `/api/specs`; the client uses `fetch`. PASS.
- **III. Delegate / Claude codes**: Build Studio is a LOCAL agent; `implement` is delegated to the Developer (Claude). PASS.
- **IV. Minimize blast radius**: building Build Studio is a BOS source change performed by the Developer on a feature branch under the supervisor; nothing here bypasses that. PASS.
- **V. VFS ≠ source**: spec tools are jailed to `specs/` + `.specify/` (not the VFS, not arbitrary `src/`); Build Studio has no DEV_TOOLS. PASS.
- **VI. Specs & docs sync**: this change updates `docs/usage` + `docs/dev`; ongoing sync is Build Studio's purpose. PASS.
- **VII. Respect boundaries**: the jail prevents touching secrets / `package.json` / lockfiles / build config. PASS.

No violations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-build-studio/
├── spec.md        # done
├── plan.md        # this file
└── tasks.md       # next (/speckit.tasks)
```

`research.md` / `data-model.md` / `contracts/` are omitted for v1: there is no external
research, the data model is small (described below), and the single internal HTTP
contract (the `/api/specs` route) is documented inline here.

### Source Code (BOS repository)

```text
src/
├── lib/
│   ├── dev/
│   │   └── spec-fs.ts            # NEW — list/read/write/edit/search jailed to specs/ + .specify/
│   ├── specs/
│   │   ├── types.ts              # NEW — Specification / Artifact / PipelinePhase / Task (framework-free)
│   │   └── pipeline.ts           # NEW — derive per-feature pipeline status; NNN-slug numbering
│   └── agent/subagents/
│       ├── tools.ts              # EDIT — add SPEC_TOOLS + delegate_to_developer (opt-in)
│       ├── runner.ts             # EDIT — build delegate_to_developer in runLocal (event-forwarding, depth-guarded)
│       └── store.ts              # EDIT — seed the Build Studio agent (+ additive ensure-exists)
├── app/api/specs/
│   └── route.ts                  # NEW — GET tree/artifact+status; PUT artifact (atomic)
└── apps/build-studio/
    ├── manifest.ts               # NEW — AppManifest (id "build-studio", icon)
    └── index.tsx                 # NEW — left tree + main pipeline/artifact pane

src/lib/agent/skills/store.ts     # EDIT — seed the "Build Studio" driver skill (+ references)
```

**Structure Decision**: single BOS project. Build Studio is a built-in app folder
(auto-discovered by `tools/gen-apps.mjs`), with server logic under `src/lib` behind one
API route, and the agent + skill shipped through the existing seed arrays.

## Design notes

### Spec filesystem jail (`src/lib/dev/spec-fs.ts`)
Mirror `repo-fs.ts`, but confine BOTH reads and writes to `specs/` and `.specify/`
(resolve the path, assert it is within those roots, deny `..` escapes). Functions:
`listDir, readFile, writeFile, editFile` (unique find/replace), `search`. Server-only.

### Spec tools (`SPEC_TOOLS` in `subagents/tools.ts`)
`list_specs, read_spec, write_spec, edit_spec, search_specs` — thin wrappers over
spec-fs. Added to `ALL_TOOLS` but NOT to the default `SUBAGENT_TOOLS` (opt-in, exactly
like `DEV_TOOLS`). Build Studio lists them in its `tools`.

### Build Studio agent (seed in `subagents/store.ts` `DEFAULTS`)
`type: "local"`; `tools: ["list_specs","read_spec","write_spec","edit_spec","search_specs","delegate_to_developer"]`.
The systemPrompt is **thin** (FR-013): identity + "operate via your skills — load and follow
the 'Build Studio' skill." Behavior lives in the skill, not the prompt, so the agent stays
extensible. Hard rules kept in the prompt: keep artifacts confined to `specs/` + `.specify/`;
NEVER write source; for `implement`, use `delegate_to_developer`.

### Implement delegation (nested-capable)
Build Studio delegates `implement` to the Developer in BOTH modes — active personality and
nested sub-agent — via a new `delegate_to_developer` sub-agent tool (not the top-level
CopilotKit action, which a nested sub-agent cannot reach). Tool `execute` does not normally
receive `onEvent`, so the tool is built per-run inside `runLocal` (`subagents/runner.ts`) as a
factory closed over the parent `onEvent`: it calls `runSubAgent(getSubAgent("developer"),
task, {onEvent})`, forwarding the nested Developer's events (with agent attribution) into the
existing per-agent nested event UI, and carries a depth guard against runaway nesting. The
Developer is `type: "claude"`, so the nested call runs through the Claude harness. Build Studio
still never writes source itself (FR-005, Principle III).

### "Build Studio" skill — the driver (seed in `skills/store.ts` `SEED`)
A directory skill `build-studio/` with `SKILL.md` (pipeline triage: which phase/command, when
to use) + `references/{constitution,specify,clarify,plan,tasks,analyze,implement,converge}.md`.
Each reference is the matching vendored `.specify/templates/commands/*.md` **adapted** to BOS —
spec-kit's bash-script / `$ARGUMENTS` mechanics replaced with Build Studio's `spec_*` tools and
(for implement) `delegate_to_developer`. Artifact bodies are created from `.specify/templates/*.md`.

This skill is the extension point (FR-013): the agent prompt stays thin and all behavior lives
here. Extend Build Studio by adding references (pipeline-coupled steps) or **companion skills**
(broadly reusable capabilities). An external-system integration needs BOTH a skill (instructions)
AND a tool/MCP (the capability): e.g. a future **GitLab integration** = a GitLab MCP/tool + a
"GitLab" skill (or reference) for publish/sync — no change to the agent or app code.

### API route (`/api/specs`)
- `GET /api/specs` → tree of `specs/` (dirs + artifact files) with per-feature pipeline status.
- `GET /api/specs?path=<rel>` → one artifact's content (+ parsed task list for `tasks.md`).
- `PUT /api/specs` `{path, content}` → atomic write via spec-fs; rejected while that feature has a running pipeline step (read-only gate, FR-011).
All server-only; the client app uses `fetch`.

### Pipeline status (`src/lib/specs/pipeline.ts`)
From a feature dir, derive phase status: **constitution** (global — `.specify/memory/constitution.md` exists & non-placeholder) · **specify** (`spec.md`) · **clarify** (`spec.md` has a Clarifications section) · **plan** (`plan.md`) · **tasks** (`tasks.md`) · **analyze/converge** (findings / `specs/discrepancies.md` entry) · **implement** (heuristic: task completion; v1 may mark "manual"). Tasks parsed from `tasks.md` checkboxes for progress. Also exposes `nextFeatureId(name)` → `NNN-slug`.

### App (`src/apps/build-studio/`)
`manifest.ts` (id `build-studio`, name "Build Studio", a Lucide icon e.g. `Hammer`/`PenTool`); `index.tsx`: left tree (GET `/api/specs`), main pane with per-artifact tabs rendering markdown (reuse the BOS markdown renderer used by Docs/Chat) + a phase-status strip + a tasks checklist with progress; empty state when `specs/` has no features (actions to create the constitution / first spec via the assistant). Live implement events: v1 shows a "working" indicator and relies on the assistant chat's existing nested event UI; deeper in-app mirroring is polish.

### Seed idempotency caveat (must handle)
`ensureSeed()` in both stores seeds only when the directory is EMPTY. Existing installs
already have populated `data/agents` / `data/skills`, so appending to `DEFAULTS` / `SEED`
alone won't add Build Studio for them. Make seeding **additive**: on startup ensure the
specific Build Studio agent + "Build Studio" skill exist (create if missing, keyed by id)
without clobbering user edits.

## Out of scope (v1)

`checklist` + `taskstoissues` commands; the BBBOS distribution; migrating the legacy
`spec/` content (Phase 2 dogfood, a separate effort); deep in-app event streaming beyond
the existing chat UI; multi-user locking.
