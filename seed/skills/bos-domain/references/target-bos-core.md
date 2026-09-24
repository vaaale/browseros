Target: Modifications to BOS itself.

Scope: anything under `src/` that is NOT a self-contained app folder — Settings tabs/pages, the desktop/dock, API routes (`src/app/api/**`), server-only stores (`src/lib/**`), OS primitives (`src/os/**`), the store (`src/store/**`), shared components. If the change is inside `src/apps/<id>/`, use `references/target-builtin-app.md` instead (same mechanics, different conventions on top).

**Before delegating here, one more check.** If what actually drove you toward `bos-core` was "this needs to handle a raw/non-standard protocol, arbitrary HTTP verbs, or run as a continuous background process" — stop and read `references/target-marketplace-item.md` first. That's usually a marketplace item's service facet (an installed item's own worker-thread process on its own port, outside Next.js entirely), not a reason to add routing/middleware to `src/`. This is not hypothetical: a real spec concluded "Next.js rejects PROPFIND/MKCOL/COPY/MOVE, therefore add `src/middleware.ts`" and ended up here when it should have gone to `target-marketplace-item.md` instead — the middleware edit was never actually necessary.

## Mechanism

This is always `dev_delegate`, never `agent_delegate`. `dev_delegate` unconditionally runs the Developer with full BOS-source access (`contentOnly` is not a parameter you can set here — the tool hardcodes it off), so:

1. **Before delegating**, this conversation needs an Active feature branch. Check by attempting the delegation or asking the user; if none is set, call `dev_branch_request` first:
   - `task`: a short description of the change.
   - `suggestedBranch`: `bos/<kebab-slug>` (derive from the feature id/slug if one exists).
   The user confirms or edits the name in an elicitation card; only proceed once it reports the branch is active. If the user cancels, stop — do not delegate.
2. Call `dev_delegate` with the spec/plan/tasks PATH (`specs/<store>/<id>/` — mounted read-only in the Developer's worktree, so it reads them itself) and any file/area hints you already have (e.g. from `bos_source_search`) — do not re-type a summary of the spec's contents into the task; see `references/implement.md` for the exact handover template and standing constraints.
3. `dev_delegate` provisions an isolated preview git worktree for that branch (the Supervisor), edits real BOS source there, runs typecheck/lint, and stages the changes. Source edits hot-reload in that preview — they are NEVER visible in the live/base checkout, so don't go looking for them there.
4. The user promotes or discards from the Topbar's feature-branch controls (`Promote` / `Stop` / `Discard` — usually distinct from the separate "app preview" `Promote app`/`Discard app` pair used for marketplace-item installs, see `target-marketplace-item.md` for the one case where they actually coincide). You never merge or discard branches yourself.

You may use `bos_source_list`/`bos_source_search`/`bos_source_read` and `dev_git_status` for READ-ONLY recon to write a grounded delegation brief (e.g. to name the likely files, or to check whether a branch/worktree already has pending changes) — never to edit anything yourself. Your `file_*` tools do not reach `src/` at all (VFS-only: `/Specs`, `/Docs`, `/Methods/<id>/templates`, user sandbox).

Note: this worktree's `data/user-apps` is a real, branch-coupled path (not a throwaway snapshot), so it's now safe if a task happens to touch it. That does NOT make it a shortcut, though — if the task also involves a marketplace item, keep that a separate delegation via `target-marketplace-item.md` (`agent_delegate`+`app_install`/`app_build`); there is no tool that installs/symlinks an item the Developer wrote there directly.

## Problem reports on an existing BOS-core change

Relay immediately: `dev_delegate` with the user's report near-verbatim, plus whatever spec path or file hint you already have. Do not read the source yourself to form a theory first — the Developer has full worktree access and does that investigation as part of the same call. If the conversation already has an active feature branch for this work, reuse it (don't call `dev_branch_request` again). If this is a fresh area with no active branch, set one up first as in step 1.

## After the Developer reports back

- Relay exactly what changed and how to test it.
- Run `analyze`/`converge` (see those references) only if the user wants a spec/architecture consistency check, or to record drift in `bos-system-specs/discrepancies.md`.
- Ensure docs under `docs/usage`/`docs/dev` were updated as part of the change (the Developer's job, per the delegation brief) — flag it if they weren't. These two trees are for BOS itself ONLY. If the change MOVED a feature out of BOS core into a marketplace item, the update is a DELETION here — the item carries its own docs inside itself now (see `target-marketplace-item.md` § "The `docs/` facet") and the Docs app renders both trees merged, so leaving the core pages behind shows the user two versions of the same documentation with no way to tell which is live.
