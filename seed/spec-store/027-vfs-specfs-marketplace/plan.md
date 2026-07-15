# Implementation Plan: User-Spec Relocation — VFS Mount Points, SpecFS, Feature Context, Spec Provider Registry

**Branch**: `027-vfs-specfs-marketplace` | **Date**: 2026-07-15 (revised post-review-v2) | **Spec**: [spec.md](./spec.md) | **Reviews**: [spec-review.md](./spec-review.md), [spec-review-v2.md](./spec-review-v2.md) | **Tasks**: [tasks.md](./tasks.md)

## Summary

Give the VFS a **mount table** routing path prefixes to pluggable `FSBackend` implementations. `Documents/Specs/` mounts to **SpecFS** — an *adapter* over the existing `src/lib/dev/spec-fs.ts` + Supervisor worktree engine (020), **not** a new git engine. SpecFS enforces a **Feature Context** on every write, resolves the active `bos/feat/<id>` branch, and routes writes to a worktree (Supervisor-provisioned preferred; self-provisioned fallback for spec-only features, pruned on hand-off). Reads are ref-pinned. Commits are debounced with bounded-diff LLM messages. Promotion force-flushes, reconciles `main` into the branch (conflicts first-class), and prunes the worktree. **User specs** live in `data/specs/user/` (VFS-writable, wipe-safe); **system specs** are read-only, mirrored from source on boot, edited as source via the Developer agent. Specs adopt a **Spec Provider Registry** (builtin/user). `BOS_SPECS_ROOT` is removed *last*, gated on migrating every consumer, including the Supervisor repoint.

**Scope (review v2, N4):** relocation only. Marketplace, the three-source app model, opaque-origin sandbox, and the iframe SDK library are in **`028-marketplace-sandbox`**.

## Technical Context

**Language/Version**: TypeScript, Node ≥ 20. Next.js App Router. Zustand vanilla store.

**Primary Dependencies**: git via `execFile` (no shell). Reuse existing `store-git.ts` helpers (`readFileAtBranch`, `commitOnSave`, `DRAFT_BRANCH` regex) and `src/lib/dev/spec-fs.ts`. No new runtime deps.

**Storage** (fixed under `dataDir()`; no env var):
```
data/specs/user/                        ← user-specs canonical git repo (SpecFS backing)
data/specs/.worktrees/<enc-branch>/     ← self-provisioned worktrees, spec-only features (flat-encoded name, N6)
data/specs/system/                      ← MIRRORED from seed/spec-store/ on boot, READ-ONLY (N2)
(active feature is per-conversation: Documents/Chats/<id>.json activeFeatureBranch)
```
`data/vfs/Documents/Specs/` is a mount-point stub so it appears in listings; reads/writes route to SpecFS.

**Server boundary**: git ops, SpecFS, feature-scope resolution, and LLM commit-message calls are server-only. The active feature is per conversation (its `activeFeatureBranch`); a request-scoped AsyncLocalStorage carries the conversation/branch so generic VFS writes resolve it (no global state, no OS-store mirror).

**Testing**: unit tests for correctness/security boundaries — mount path-escape, no-context error, debounce coalescing, wipe-survival, `id` sanitization. Plus a **manual/e2e LVC checklist** for the Supervisor repoint (N5). `npx tsc --noEmit` + `npm run lint` per phase.

**Migration**:
- One-time in `seed.ts` — if `data/specs/user/` is absent but a legacy `BOS_SPECS_ROOT/user-specs` exists, copy + log.
- System specs **mirror** into `data/specs/system/` on each boot (overwrite/prune), not additive (N2).
- **In-flight system specs (N8)**: specs authored under the old writable model currently live in `specs/bos-system-specs/` (runtime container), not `seed/spec-store/`. As part of closeout they are lifted into `seed/spec-store/` so Option B's source-home invariant holds and existing in-progress specs (including 027/028 themselves) aren't stranded.
- `BOS_SPECS_ROOT` removal is the final step, gated on the consumer enumeration (Phase 3).

## Constitution Check

- **I. Spec-Driven — SAAP**: plan derives from `spec.md`; tasks in `tasks.md`. PASS.
- **II. Server Authority & SSR Boundary**: all FS/git/context/LLM work is server-only; the client holds a read-only context mirror. PASS.
- **III. Always Delegate; Claude Codes**: system-spec edits and all source work run via the Developer sub-agent on the feature branch — now the *only* system-spec path (Option B). PASS.
- **IV. Minimize Blast Radius**: SpecFS *adopts* the existing worktree engine (no parallel git model); unmounted VFS paths unchanged; `stores.ts` public API preserved; env-var removal gated on full consumer migration; marketplace/sandbox scope split out (N4). PASS.
- **V. The VFS Is Not the Source**: `Documents/Specs/` routes to `data/specs/user/`, never `src/`. System specs (source) are edited only via the Developer agent. PASS.
- **VI. Specs & Docs Stay in Sync**: closeout updates `overview.md`, `docs/dev/self-modification/live-version-control.md`, `docs/dev/repository-and-data-layout.md` *as part of* the Supervisor repoint. PASS.
- **VII. Respect Boundaries**: `package.json`/lockfiles untouched (git via `execFile`). PASS.

No violations.

## Phase 1 — VFS Mount Points + server-authoritative Feature Context

Critical path.

- **Mount table** (`src/os/fs-types.ts`, `src/os/vfs.ts`): `FSBackend` interface mirroring the current VFS surface; `MountPoint`; `registerMount`/`resolveMount`. All nine VFS functions check the mount first, else fall through to `LocalFS` (extracted, no behaviour change). **Unit-test the path-escape jail on `resolveMount`.**
- **Feature scope module** (`src/lib/specs/feature-context.ts`, server-only): a request-scoped AsyncLocalStorage feature scope. `withFeatureScope({conversationId?, branch?}, fn)`, `currentFeatureScope()`, and `getActiveBranch()` — resolve an explicit `scope.branch`, else the conversation's `activeFeatureBranch`, else undefined. No global file, no mutation API (the conversation owns its branch; option-(b) apps set `scope.branch`).
- **Feature scope seeding** (integration): agent tool calls wrap execution in `withFeatureScope({ conversationId })`; the VFS API route reads a conversation/branch header and wraps the request. No global API route or OS-store mirror (removed — the conversation is the source of truth).

## Phase 2 — SpecFS adapter + worktree writes + Promotion

- **SpecFS** (`src/os/fs/spec-fs.ts`): an `FSBackend` **adapter** over `src/lib/dev/spec-fs.ts`. No `git checkout`.
  - Resolve active branch from the feature-context module; refuse writes with `SpecFSNoContextError` when none.
  - **Reads ref-pinned** via `readFileAtBranch` (active branch, else `main`).
  - **Writes → worktree**: Supervisor worktree when a preview exists; else self-provision `data/specs/.worktrees/<enc-branch>/` via `git worktree add`. **Flat-encode the branch to the dirname** (slashes → safe separator, N6) so the startup sweep and cleanup never walk nested dirs.
  - **N1 hand-off**: on resolving the write root, if a Supervisor preview now exists for the active branch and SpecFS holds a self-provisioned worktree for it, `flushPending` then `git worktree prune` the self-provisioned one before deferring to the Supervisor's.
  - **Debounced commit** (2 s) via `commitOnSave`; message from `generateCommitMessage(diff)` with the **diff bounded** (truncate + file-count cap) and deterministic fallback.
  - `patch(touchedSpecs)` through the feature-context module (shared mutex).
- **editFile stays a spec-layer op** (not on `FSBackend`), rewired to route through the active branch.
- **flushPending(branch)**: cancel debounce, synchronous `stageAll → commit`. Precondition for any committed-state read.
- **Startup sweep**: on init / first access, `hasUncommitted` on the canonical repo + active worktrees → recovery commit.
- **Seed** (`src/lib/specs/seed.ts`): init `data/specs/user/` git repo + `spec-store.json` (`writable: true`); one-time migrate legacy `BOS_SPECS_ROOT/user-specs`; **mirror** system specs into `data/specs/system/` (overwrite/prune, N2).
- **Mount registration** (explicit ordering): ensure `data/specs/user/` exists **before** `registerMount('/Documents/Specs', new SpecFS(...))`.
- **Promotion** (`src/lib/specs/promote.ts`): `flushPending` → reconcile `main` into the feature branch in its worktree → on conflict `git merge --abort` and return `{ kind: 'conflict', files }` → else fast-forward `main`, prune worktree, `clear()` context. Returns `spec-only | source-included | conflict`.
- **Feature-context entry points**: Build Studio "New feature" action, assistant `start_feature` tool, one-click quick-edit (pre-filled id). Behaviour-change note documented: no-branch commit-on-save is gone.
- **spec-write tool** → `vfs.writeText('Documents/Specs/…')`.
- **Tests**: no-context error; debounce coalescing (US1.3); wipe-survival (US4); promote conflict contract (US3.3); N1 hand-off (US2.3).

## Phase 3 — Spec Provider Registry + BOS_SPECS_ROOT migration + Supervisor repoint

- **SpecProvider / SpecRegistry** (`src/lib/specs/provider.ts`): aggregate builtin → user. (Marketplace provider lands in 028.)
- **BuiltinSpecProvider** — `data/specs/system/`, `canWrite: false` (**single source of truth**: provider `canWrite` derives from the store manifest `writable`; system manifest `writable: false`).
- **UserSpecProvider** — `data/specs/user/`, `canWrite: true`.
- **`stores.ts` rewrite** — delegate to the registry; preserve public API.
- **Consumer enumeration (gate)**: grep every `BOS_SPECS_ROOT` / `specsRoot` consumer — at least `stores.ts`, `seed.ts`, `specs-dir.ts`, `pipeline.ts`, `skills/store.ts`, and `tools/supervisor/supervisor.mjs` — and migrate each to the fixed layout.
- **Supervisor repoint** (`tools/supervisor/supervisor.mjs`): point its per-preview/base spec-store paths and promote-merge logic at `data/specs/…` (a repoint, not a rewrite).
- **N5 LVC verification** (manual/e2e checklist): start a preview on a feature branch, write a spec through the VFS, confirm it appears in the preview worktree, promote, confirm `main` fast-forwards and the worktree is pruned.
- **Bastion**: remove `BOS_SPECS_ROOT` injection (`provision.ts`, `docker.ts`); ensure `data/config/` exists.
- **Remove `src/os/specs-dir.ts` and `BOS_SPECS_ROOT`** — *last*, only after every consumer is migrated.

## Phase 4 — Developer-agent feature-branch wiring (via Supervisor)

- When a feature context is active and the Developer agent edits BOS source, it works through the **Supervisor** for `bos/feat/<id>` (worktree + port pool) — **never a raw checkout of the running tree** (fragile-main hazard). After each commit it PATCHes `touchedSourcePaths`.

## Closeout

- Update `overview.md`; mark 018 FR-005/FR-007 Superseded and 020 Adopted; note 028 as the follow-on.
- Lift in-flight system specs from `specs/bos-system-specs/` into `seed/spec-store/` (N8).
- Update `docs/dev/architecture-overview.md`, `docs/dev/self-modification/live-version-control.md`, `docs/dev/repository-and-data-layout.md`, and `docs/usage/` (Feature Context workflow, writing specs from any app).
