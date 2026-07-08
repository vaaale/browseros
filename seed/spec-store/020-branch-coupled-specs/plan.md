# Implementation Plan: Branch-Coupled Spec Provisioning (020)

## Touched areas

1. **`tools/supervisor/supervisor.mjs`** (core)
   - `listSpecStores()`: subdirs of `SPECS_ROOT` having `.git` + `spec-store.json`.
   - `mountSpecStores(wt, branch)` (replaces symlink version): per store — remove legacy symlink; keep an intact existing mount; else `git worktree prune` the store, then `git worktree add <wt>/specs/<store> <branch>` (existing branch) or `git worktree add -b <branch> <dst> <default>` (new, off the store's checked-out default). Called from `beginPreview` and `restorePreviews`.
   - `commitSpecStores(wt, branch)`: `git add -A` + commit in each mounted store worktree; called from `buildAndStart` next to the code commit, and before promote.
   - `specStoreConflicts(branch)`: per store with the branch, `git merge-tree` pre-check against default; called in `promote()` before any irreversible step.
   - `promoteSpecStores(branch)`: merge branch into default in the canonical store, then `git worktree remove --force` the mount registration + `git branch -D`; called after the code promote's point of no return in BOTH base modes (live-checkout and swap).
   - `discardSpecStores(branch, wt)`: worktree remove/prune + branch delete; called from `discardPreview`.
   - `reconcileWorktrees()`: additionally `git worktree prune` each store.
   - `startProc` / `startBaseDevProc` env: `BOS_SPECS_ROOT` = `<worktree>/specs` for previews / canonical `SPECS_ROOT` for base; previews also get `BOS_SPECS_SEED=0`.

2. **`src/lib/specs/seed.ts`** — `ensureStores()` no-ops when `BOS_SPECS_SEED=0`.

3. **`src/lib/specs/store-git.ts`** — delete `beginCandidate`/`hasCandidate`/`promoteCandidate`/`discardCandidate` (+ `CANDIDATE`). Add read-side helpers: `listDraftBranches(root)` (`bos/*` differing from default), `draftFeatures(root, branch)` (changed top-level feature dirs + files from `git diff --name-only <default>...<branch>`), `readFileAtBranch(root, branch, rel)` (`git show`). Branch-name validation before any git arg.

4. **`src/lib/dev/spec-fs.ts`** — `prepareWrite` loses the candidate hop (commit-on-save already happens); add `readFileAt(path, branch)`.

5. **`src/lib/specs/pipeline.ts`** — `specTree()`: drop `hasCandidate`; append per-branch draft feature nodes (with `branch` set on nodes) to each group.

6. **`src/lib/specs/types.ts`** — `SpecTreeNode`: remove `hasCandidate`, add `branch?: string`.

7. **`src/app/api/specs/route.ts`** — GET accepts `&branch=` (read via `readFileAt`); POST (promote/discard/status) removed.

8. **`src/apps/build-studio/index.tsx`** — remove candidate Promote/Discard buttons + `runStoreAction`; render draft nodes with a branch badge; branch-opened files are read-only (no Edit).

9. **Seeded agent/skill text** (`src/lib/agent/subagents/store.ts`, `skills/store.ts`, `subagents/tools.ts`, `SpecActions.tsx` descriptions) — replace candidate-branch wording with feature-branch wording.

10. **Docs** — `docs/dev/self-modification/live-version-control.md`, `docs/dev/repository-and-data-layout.md`, `docs/dev/build-studio.md`. Note 018 FR-005/FR-007 supersession in `discrepancies.md`.

## Ordering & verification

Implement 1–2 (supervisor + seed gate) → 3–7 (app read/write path) → 8–9 (UI/text) → 10 (docs). Verify: `npx tsc --noEmit`, `npm run lint`, plus a scripted supervisor smoke test against throwaway git repos exercising mount → new-file commit → visible-from-canonical → promote → discard.

## Risks

- Promote ordering: store merge conflicts must fail the promote before the base ref moves (pre-check), while store merges themselves happen after the code promote commits — a store merge failure after that point logs loudly and leaves the branch for manual merge (same posture as code).
- Existing previews created under the symlink design: first re-provision replaces the symlink (migration path in `mountSpecStores`).
