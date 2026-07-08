# BrowserOS Constitution

## Core Principles

### I. Spec-Driven — Software As A Prompt (NON-NEGOTIABLE)
Every feature is defined by a specification under `specs/` before it is built. The
spec is the source of truth; code is a derivative artifact. Work follows the pipeline
constitution → specify → clarify → plan → tasks → implement. A feature without an
agreed `spec.md` MUST NOT be implemented. BOS is designed to be distributable as a
thin kernel plus its specifications.

### II. Server Authority & SSR Boundary
Secrets, Node APIs, and the filesystem live only in server code behind
`src/app/api/**/route.ts`; clients communicate over `fetch`. Framework-free domain
types live in `src/os/types.ts`. API keys are never returned to the client in
plaintext. Reasoning/"thinking" models MUST use the Chat Completions API, a
sufficiently large output-token budget, and surface `reasoning_content` as visible
thinking.

### III. Always Delegate; Claude Codes
The assistant delegates substantive work to a sub-agent, creating one if none fits.
ALL development/coding tasks MUST run on a Claude sub-agent; every other task defaults
to a local sub-agent. Using a Claude agent for a non-development task requires explicit
user permission.

### IV. Minimize Blast Radius (NON-NEGOTIABLE)
Every change to BOS is made on a feature branch. Because BOS can edit its own source,
self-modification runs multiple versions concurrently: a stable Supervisor owns
lifecycle / preview / promote / rollback, the developer edits an isolated worktree
(never the running tree), and a previewed candidate gets copy-on-write-isolated data.
Promote is code-only; a candidate self-tests (Playwright) before promotion.

### V. The VFS Is Not the Source
`data/vfs` is the user's sandbox, not BOS source. BOS code is changed only by editing
`src/` (via the developer sub-agent), never through VFS file tools. All runtime state
persists as files under `./data` (gitignored); versioned, user-authored content (apps)
lives in its own content repo (GitFS), not the BOS source tree.

### VI. Specs & Docs Stay in Sync (NON-NEGOTIABLE)
Whenever a feature is added, modified, or removed, its spec under `specs/` and the
documentation (`docs/usage` for end users, `docs/dev` for the developer agent) MUST be
updated in the same change. Where code and spec diverge, record it in
`specs/discrepancies.md`.

### VII. Respect Boundaries
Never modify secrets, `package.json`, lockfiles, or build configuration unless
explicitly asked. Confirm destructive operations before performing them. Quality gates
(`npx tsc --noEmit`, `npm run lint`) must pass for changed code; do not run
`npm run build` while `next dev` is running.

## Technology Constraints
- Single-page, server-side-rendered BrowserOS on Next.js (App Router) + React +
  Zustand, with a CopilotKit-based assistant.
- AI providers are OpenAI-compatible (OpenAI, Codex, Anthropic, local models);
  model / keys / base-URL / max-output-tokens / context-window are user-configurable.
- Built-in apps are self-describing folders `src/apps/<id>/` (manifest + entry),
  auto-discovered — no central registry. Installed apps are sandboxed iframes served
  from the content repo.
- Configuration namespaces are pluggable (`src/lib/config/registry.ts`) and every
  namespace is auto-exposed to the assistant as tools.
- Agents, skills, and memory are markdown under `data/`.

## Development Workflow
- The spec-kit pipeline IS the workflow. Author and refine specs with Build Studio;
  implementation (`/speckit.implement`) is delegated to the Developer (Claude)
  sub-agent — Build Studio never writes application code itself.
- Cross-artifact consistency (`/speckit.analyze`) and codebase-vs-spec drift
  (`/speckit.converge`) are run to keep specs authoritative; drift is recorded in
  `specs/discrepancies.md`.
- A change is complete only when: the spec and docs are updated, typecheck and lint
  pass, and (for promotable changes) self-tests pass.

## Governance
This constitution supersedes other practices. Amendments are made by editing this file
with a version bump and a dated note; complexity that violates a principle must be
justified in the feature's `plan.md` (Complexity Tracking) or rejected. `CLAUDE.md`
orients the developer agent and MUST point here. All specs, plans, and reviews verify
compliance with these principles.

**Version**: 1.0.0 | **Ratified**: 2026-06-28 | **Last Amended**: 2026-06-28
