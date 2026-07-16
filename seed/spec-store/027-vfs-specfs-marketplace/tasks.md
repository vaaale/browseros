# Tasks: 027 User-Spec Relocation — VFS Mount Points, SpecFS, Feature Context, Spec Provider Registry

Feature branch: `027-vfs-specfs-marketplace`. Task ids match the plan phases. `[P]` = parallelizable within its phase. `[T]` = test task (first-class).

> Scope: relocation only. Marketplace, app provider registry, opaque-origin sandbox, and iframe-SDK-as-library are in **`028-marketplace-sandbox`**.

## Phase 1 — VFS Mount Points + server-authoritative Feature Context

- [ ] P1.1. `src/os/fs-types.ts` (new) — `FSBackend` (mirrors the current VFS surface) + `MountPoint`. Backend paths are mount-relative.
- [ ] P1.2. `src/os/fs/local-fs.ts` (new) — `LocalFS implements FSBackend`; mechanical extraction of current `vfs.ts` resolution + `fs/promises`. No behaviour change.
- [ ] P1.3. `src/os/vfs.ts` (modify) — `registerMount`, `resolveMount`; all nine functions delegate on match, else fall through to `LocalFS`.
- [x] P1.4. [T] Unit test — `resolveMount` path-escape jail (`..`, absolute, encoded traversal) at the mount boundary.
- [x] P1.5. `src/lib/specs/feature-context.ts` (new, server-only) — request-scoped AsyncLocalStorage feature scope: `withFeatureScope`, `currentFeatureScope`, `getActiveBranch()` (explicit `scope.branch` → conversation `activeFeatureBranch` → none). Per-conversation; NO global file/API/mutation verbs.
- [x] P1.6. `src/lib/specs/feature-id.ts` (new) — `sanitizeFeatureId` (slug for create-branch UI) + `encodeBranchDir` (worktree dir, N6). [T] unit-tested.
- [x] P1.7. `npx tsc --noEmit` + `npm run lint` green; unit tests pass.

> Removed vs the original global design: `src/os/types.ts` FeatureContext types, the `/api/feature-context` route, and the OS-store `activeFeature` mirror + BroadcastChannel are NOT part of the per-conversation model.

## Phase 2 — SpecFS adapter + worktree writes + Promotion

- [ ] P2.1. `src/os/fs/git-fs.ts` (new) — thin `GitFS` helpers over `execFile('git', …)`: worktree add/prune, `hasUncommitted`, `stageAll`, `commit`, `merge --abort`, fast-forward. **No base checkout.**
- [ ] P2.2. `src/os/fs/spec-fs.ts` (new) — `FSBackend` adapter over `src/lib/dev/spec-fs.ts`: resolve active branch from the feature-context module; `SpecFSNoContextError` when none; **ref-pinned reads** via `readFileAtBranch`.
- [ ] P2.3. Worktree write routing — Supervisor worktree when a preview exists; else self-provision `data/specs/.worktrees/<enc-branch>/` (**flat-encode** the slashed branch, N6) via `git worktree add`.
- [ ] P2.4. N1 hand-off — when a Supervisor preview exists for the active branch and SpecFS holds a self-provisioned worktree for it, `flushPending` then `git worktree prune` before deferring to the Supervisor's.
- [ ] P2.5. Debounced commit (2 s) via `commitOnSave`; `generateCommitMessage(diff)` with **bounded diff** (truncate + file-count cap) and deterministic fallback.
- [ ] P2.6. `touchedSpecs` appended via the feature-context module `patch` (shared mutex) — no direct file write.
- [ ] P2.7. Rewire `editFile` (spec layer, not `FSBackend`) to route through the active branch.
- [ ] P2.8. `flushPending(branch)` — cancel debounce + synchronous `stageAll → commit`; precondition helper for committed-state reads.
- [ ] P2.9. Startup sweep — `hasUncommitted` on canonical repo + active worktrees → recovery commit.
- [ ] P2.10. `src/lib/specs/seed.ts` (modify) — init `data/specs/user/` git repo + `spec-store.json` (`writable: true`); one-time migrate legacy `BOS_SPECS_ROOT/user-specs`; **mirror** system specs into `data/specs/system/` (overwrite/prune, not `copyMissing`; system store only — N2).
- [ ] P2.11. Register SpecFS mount **after** ensuring `data/specs/user/` exists (explicit ordering).
- [ ] P2.12. `src/lib/specs/promote.ts` (new) — `flushPending` → reconcile `main` into feature branch → conflict ⇒ `{ kind: 'conflict', files }` (abort, `main` untouched) → else fast-forward `main`, prune worktree, `clear()`. Returns `spec-only | source-included | conflict`.
- [ ] P2.13. Feature-context entry points — Build Studio "New feature", assistant `start_feature` tool, one-click quick-edit (pre-filled id).
- [ ] P2.14. Update spec-write tool → `vfs.writeText('Documents/Specs/…')`.
- [ ] P2.15. [T] Unit tests — no-context error; debounce coalescing (US1.3); wipe-survival (US4); promote conflict contract (US3.3); N1 hand-off prune (US2.3).
- [ ] P2.16. `npx tsc --noEmit` + `npm run lint` green.

## Phase 3 — Spec Provider Registry + BOS_SPECS_ROOT migration + Supervisor repoint

- [ ] P3.1. `src/lib/specs/provider.ts` (new) — `SpecProvider` + `SpecRegistry` (builtin → user).
- [ ] P3.2. [P] `src/lib/specs/providers/builtin.ts` — scans `data/specs/system/`; `canWrite` derived from manifest `writable: false` (single source of truth).
- [ ] P3.3. [P] `src/lib/specs/providers/user.ts` — `data/specs/user/`, `canWrite: true`.
- [ ] P3.4. `src/lib/specs/stores.ts` (rewrite) — delegate to `SpecRegistry`; preserve public API.
- [ ] P3.5. **Consumer enumeration (gate)** — grep every `BOS_SPECS_ROOT`/`specsRoot` consumer (`stores.ts`, `seed.ts`, `specs-dir.ts`, `pipeline.ts`, `skills/store.ts`, `tools/supervisor/supervisor.mjs`, …); migrate each to the fixed layout.
- [ ] P3.6. **Supervisor repoint** (`tools/supervisor/supervisor.mjs`) — per-preview/base spec-store paths and promote-merge logic point at `data/specs/…`. Repoint, not rewrite.
- [ ] P3.7. [T] **LVC verification** (manual/e2e checklist, N5) — start a preview on a feature branch; write a spec via the VFS; confirm it appears in the preview worktree; promote; confirm `main` fast-forwards and the worktree is pruned.
- [ ] P3.8. [P] `bastion/src/provision.ts` + `docker.ts` — remove `BOS_SPECS_ROOT` injection; ensure `data/config/`.
- [ ] P3.9. Delete `src/os/specs-dir.ts` and remove `BOS_SPECS_ROOT` — **only after** P3.5/P3.6 land.
- [ ] P3.10. `npx tsc --noEmit` + `npm run lint` green (BOS + bastion).

## Phase 4 — Developer-agent feature-branch wiring (via Supervisor)

- [ ] P4.1. When a feature context is active and the Developer agent edits BOS source, route through the **Supervisor** for `bos/feat/<id>` (worktree + port pool) — never a raw checkout of the running tree.
- [ ] P4.2. After each source commit, PATCH `/api/feature-context` to append `touchedSourcePaths`.
- [ ] P4.3. `npx tsc --noEmit` + `npm run lint` green.

## Closeout

- [ ] C1. Update `overview.md`; mark 018 FR-005/FR-007 Superseded, 020 Adopted; note 028 as follow-on.
- [ ] C2. Lift in-flight system specs from `specs/bos-system-specs/` into `seed/spec-store/` (N8).
- [ ] C3. Update `docs/dev/architecture-overview.md`, `docs/dev/self-modification/live-version-control.md`, `docs/dev/repository-and-data-layout.md`.
- [ ] C4. Update `docs/usage/` — Feature Context workflow, writing specs from any app.
