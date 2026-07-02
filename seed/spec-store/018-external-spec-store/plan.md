# Implementation Plan: External Spec Stores (System + User)

**Branch**: `018-external-spec-store` | **Date**: 2026-07-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/018-external-spec-store/spec.md`

## Summary

Move specifications out of the BOS source tree into independent git repos discovered under a
single container root `BOS_SPECS_ROOT`. Each store is a self-describing folder (a git repo +
a manifest declaring `owner`/`writable`/`requiresPromote`); the system store is seeded from a
shipped bundle, the user store is user-owned. Specs are versioned as **content** — edited in
place and promoted by a build-free `git merge` (the `app-candidate` model), never through the
code preview/build path. `spec-fs` becomes multi-root, Build Studio renders one group per
store, and the developer harness receives the target store as a read-only mount at implement
time. A migration removes `specs/` + the constitution from BOS source tracking and repoints
every reference.

## Technical Context

**Language/Version**: TypeScript — Next.js (App Router), React, Node ≥ 20 (matches BOS). Supervisor is plain Node ESM.

**Primary Dependencies**: existing BOS subsystems — GitFS (`src/lib/gitfs/store.ts`), `atomic-write`, spec-fs, `/api/specs`, the Supervisor worktree provisioner. No new runtime deps.

**Storage**: Filesystem + git. N independent git repos under `BOS_SPECS_ROOT` (default `<cwd>/specs`, gitignored). Shipped seed bundle tracked under `seed/spec-store/`. spec-kit engine stays under `.specify/templates` + scripts.

**Testing**: Playwright e2e for the BS two-group tree + a build-free promote; unit/contract tests for store discovery, manifest parsing, the multi-root spec-fs jail, and the seed/additive-update logic.

**Target Platform**: BOS (SSR web app), with and without the self-modification Supervisor.

**Project Type**: Web — single Next.js project (the BOS repo), plus a Supervisor edit.

**Performance Goals**: Store discovery + spec reads are local fs/git; tree render < 100 ms for typical stores. Promote is a single `git merge` (no build).

**Constraints**: Server/client boundary (stores are server-only behind `/api/specs`); per-store jail; the container root is never itself a git repo; marketplace stores are read-only unless their manifest says `writable`.

**Scale/Scope**: A handful of stores × tens of features each. v1 stores: system + user (marketplace is design-forward, not seeded).

## Constitution Check

*GATE: must pass before design; re-check after.*

- **I. Spec-Driven — SAAP**: this feature is spec-first (plan derives from `spec.md`) and directly advances SAAP — specs become a distributable artifact rather than a source subdirectory. PASS.
- **II. Server Authority & SSR Boundary**: store discovery, manifest loading, git ops, and spec-fs are server-only (`src/lib/specs/*`, `src/lib/dev/spec-fs.ts`) behind `/api/specs`; the client uses `fetch`. PASS.
- **III. Always Delegate; Claude Codes**: implementing 018 is a BOS source change → performed by the Developer (Claude) on a feature branch under the Supervisor. Spec authoring/promote remains a local (non-coding) content operation. PASS.
- **IV. Minimize Blast Radius (NON-NEGOTIABLE)**: stores are independent repos; system-spec changes are gated behind candidate→promote; the container is never a repo (no submodule/gitlink leakage). The migration edits `.gitignore` + `CLAUDE.md` (allowed) and never touches `package.json`/lockfiles/build config. PASS.
- **V. The VFS Is Not the Source**: spec stores are neither the VFS (`data/vfs`) nor BOS source; spec-fs jails each store root separately. PASS.
- **VI. Specs & Docs Stay in Sync (NON-NEGOTIABLE)**: this updates `CLAUDE.md`, `docs/dev/repository-and-data-layout.md`, `docs/dev/api-reference.md`, `docs/dev/build-studio.md`, and `docs/usage` for Build Studio. PASS.
- **VII. Respect Boundaries**: per-store jail; secrets untouched; non-writable stores refuse writes. PASS.

No violations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/018-external-spec-store/
├── spec.md        # done
├── plan.md        # this file
└── tasks.md       # next (/speckit.tasks)
```

`research.md` / `data-model.md` / `contracts/` are omitted: no external research, the data
model is small (described below), and the single HTTP contract (`/api/specs`) is documented inline.

### Source Code (BOS repository)

```text
src/
├── os/
│   └── specs-dir.ts              # NEW — specsRoot() from BOS_SPECS_ROOT (default <cwd>/specs), mirrors apps-dir.ts
├── lib/
│   ├── specs/
│   │   ├── stores.ts             # NEW — discover stores (list root, <subdir>/.git, load manifest); StoreManifest type; active-store set
│   │   ├── store-git.ts          # NEW — per-store git: ensureRepo (reuse gitfs), commitOnSave, beginCandidate/promoteCandidate/discardCandidate (build-free merge)
│   │   └── seed.ts               # NEW — ensureSystemStore(): seed from seed/spec-store + additive ensure-exists updates
│   └── dev/
│       ├── spec-fs.ts            # EDIT — multi-root (storeId + relPath); per-store jail; writable/requiresPromote gating
│       └── repo-fs.ts            # EDIT — drop specs/ + .specify/memory/ from WRITE_ALLOW_PREFIXES
├── app/api/specs/
│   └── route.ts                  # EDIT — store dimension: list groups(stores), read/write addressed by store, promote/discard endpoints
├── apps/build-studio/
│   └── index.tsx                 # EDIT — one group per store (label from manifest), discovery-driven
└── lib/agent/subagents/
    └── claude-runner.ts          # EDIT — request the target store(s) be mounted at specs/<store>/ in the worktree

tools/supervisor/supervisor.mjs   # EDIT — mount target store(s) into the worktree at specs/<store>/ (gitignored → excluded from candidate commit); refresh on reuse
seed/spec-store/                   # NEW (tracked) — migrated system specs + constitution + system store manifest
.gitignore                         # EDIT — ignore the container root when nested
CLAUDE.md, docs/dev/*, docs/usage/* # EDIT — repoint specs/ + .specify/memory references to the stores
```

**Structure Decision**: single BOS project + one Supervisor edit. A store is a self-describing
folder (git repo + manifest) discovered by listing `BOS_SPECS_ROOT`; no central registry. Reuse
the existing GitFS module for per-store git; reuse the Supervisor worktree provisioner for the
read-only mount.

## Design notes

### Container + config (`src/os/specs-dir.ts`)
`specsRoot()` returns `BOS_SPECS_ROOT` (default `<cwd>/specs`), mirroring `apps-dir.ts`. The
root is a **plain directory**, never a git repo. Gitignored when nested in the BOS tree.

### Store discovery + manifest (`src/lib/specs/stores.ts`)
List `specsRoot()`; a subdirectory is a store iff it has both `<subdir>/.git` (detected by
`fs.access`, never `git rev-parse` — the `007-gitfs` guard) and a store manifest. Manifest file
`spec-store.json` at the store root: `{ label, owner: "system"|"user"|"marketplace", writable:
boolean, requiresPromote: boolean }`. Subdirs missing either are ignored. Returns the active
store set `{ id (dir name), label, root, owner, writable, requiresPromote }`. No central
registry file — role/policy come from each manifest, so a cloned marketplace repo carries its
own identity.

### Multi-root spec-fs (`src/lib/dev/spec-fs.ts`)
Refactor the single `ROOT` jail into `(storeId, relPath)` resolution: pick the store from the
active set, jail to `store.root`, keep path-escape refusal + size caps + text search per store.
Reads may target any store; a **write** to a store where `writable === false` is refused; a
write to a store where `requiresPromote === true` goes through the candidate branch (below),
not straight to `main`.

### Per-store git + build-free promote (`src/lib/specs/store-git.ts`)
Reuse `src/lib/gitfs/store.ts` (`ensureRepo`, `commitAll`, `history`) rooted per store. Because
a spec promote needs **no build and no preview server** and operates on an **independent** repo
(not the BOS code repo, not the running server's checkout), it is a plain **server-side git
operation** — the Supervisor is NOT involved (unlike app-candidate, which the Supervisor owns
because the running server serves the checked-out app branch). Model mirrors `appBegin/appPromote/
appDiscard`:
- **User store** (`requiresPromote:false`): commit-on-save to `main`.
- **System store** (`requiresPromote:true`): edits land on a `spec-candidate` branch (checked
  out so BS reads candidate content in place); **promote** = `checkout main` → `merge --no-edit
  spec-candidate` → delete candidate; **discard** = `checkout -f main` → delete candidate. A
  change touching the constitution requires explicit user confirmation before promote (Principle
  I / `013` constitution rule).

### Seeding + additive updates (`src/lib/specs/seed.ts`)
Ship the migrated system content (today's `specs/` + `.specify/memory/constitution.md`) as a
**tracked** bundle under `seed/spec-store/`. On startup `ensureSystemStore()`: if the system
store subdir is absent, create it, `git init`, copy the bundle, write its `spec-store.json`
(`owner:system, writable:true, requiresPromote:true`), and make the initial commit; if present,
apply **additive ensure-exists** — add spec files/dirs the bundle has but the store lacks,
without clobbering locally edited system specs (keyed by path, same idempotency discipline as
seeded agents/skills). The user store is auto-created empty (`owner:user, writable:true,
requiresPromote:false`) if absent.

### Read-only store mount for the harness (`supervisor.mjs` + `claude-runner.ts`)
At implement time the developer must read the target spec (and constitution) even though specs
left the source tree. Copy/reflink the relevant store(s) into the worktree at the **natural
path** `specs/<storeId>/…` — the explicit paths the harness already expects — NOT behind an env
var (an agent dereferencing a variable to locate files is a known failure mode). Reuse the
`hydrateWorktree` reflink→copy discipline. Because the BOS repo **gitignores** the `specs/`
container path (migration step 3), the mount is automatically excluded from `git add -A` in
`buildAndStart`, so harness edits to the copy are inert — never committed onto the code branch,
never propagated back to the store (read-only in effect, no env var / no `.git/info/exclude` /
no chmod needed). Re-sync the mount on worktree reuse so an edited spec is current. The delegation
task references the explicit `specs/<store>/…` path; the developer skill needs no env indirection.
Generalizes to any future external content root the harness must read (a small, explicit list the
Supervisor consults at `begin`).

### API route (`/api/specs`)
- `GET /api/specs` → the active store set as **groups**, each with its spec tree + per-feature pipeline status.
- `GET /api/specs?store=<id>&path=<rel>` → one artifact's content.
- `PUT /api/specs` `{store, path, content}` → write via spec-fs (refused if the store is not `writable`; routed to the candidate branch if `requiresPromote`).
- `POST /api/specs/promote` / `POST /api/specs/discard` `{store}` → build-free candidate promote/discard (system store).
All server-only; the BS app uses `fetch`.

### Build Studio app (`src/apps/build-studio/index.tsx`)
Render **one group per store** (label from the manifest, fallback dir name), each showing its
feature tree; a new store appears automatically from discovery with no code change. A promote/
discard affordance appears for stores where `requiresPromote` is true.

### Migration (performed by the Developer on this feature branch)
1. Build the `seed/spec-store/` bundle from current `specs/` (incl. `overview.md`, `discrepancies.md`, all `NNN-*`) + `.specify/memory/constitution.md`, with the system `spec-store.json`.
2. `git rm -r specs/` and `git rm .specify/memory/constitution.md` from BOS tracking; keep `.specify/templates` + scripts (the engine) tracked.
3. Add `BOS_SPECS_ROOT` (default `/specs`) to `.gitignore`.
4. Repoint references: `spec-fs` root → stores; `repo-fs` `WRITE_ALLOW_PREFIXES` (remove `specs/` + `.specify/memory/`); `CLAUDE.md`; `docs/dev/{repository-and-data-layout,api-reference,build-studio}.md`; `docs/usage` Build Studio pages.
5. First run seeds the system store from the bundle (git history for specs restarts in the store; the pre-migration history remains in the BOS repo log).
6. This 018 spec (`spec.md`/`plan.md`/`tasks.md`) migrates into the system store as part of the bundle — the last spec authored in-tree.

## Out of scope (v1)

- Seeding/registering an actual **marketplace** store (design supports it via discovery; not shipped).
- Migrating **`docs/`** to the same store model (same content class, deferred — separate effort).
- Publishing/sharing UX (git push/pull to a remote spec store) beyond what plain git already allows.
- Multi-user concurrent editing / locking.
- A doc/spec-only "fast promote" optimization beyond the plain per-store `git merge` (already build-free here, so no code fast-path needed).
