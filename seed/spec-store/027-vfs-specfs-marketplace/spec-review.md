# Review: 027 — VFS Mount Points, SpecFS, Feature Context, Provider Registry, Marketplace

**Reviewer**: Claude (design review) · **Date**: 2026-07-15 · **Artifacts**: `spec.md`, `plan.md`, `tasks.md`
**Verdict**: Strong, well-motivated design with a clean core abstraction (VFS mount table + `FSBackend`). **Not ready to implement as written.** One foundational collision (the Supervisor / 020 worktree model) and several correctness/coverage gaps must be resolved first.

---

## 1. Is the challenge properly addressed by the specification?

The spec frames three real problems (siloed spec writes, user-specs living in the source clone, closed app discovery) and the VFS-as-uniform-interface framing is the right instinct. Problems #1 (any-app writes) and #2 (wipe-survivable relocation) are addressed cleanly and convincingly. The mount-table + `FSBackend` abstraction is well-judged and matches the existing `vfs.ts` surface (`src/os/vfs.ts:80-156`), so `LocalFS` extraction (T002) is a genuine no-op refactor.

**But the spec addresses the user-specs half of the world and silently drops the system-specs half.** This is the most important substantive gap:

- Today the **system** store (`bos-system-specs`) is `writable: true` (`src/lib/specs/seed.ts:18-23`) and is where Build Studio authors the core spec, `discrepancies.md`, the constitution, and *these very feature specs* (027 lives in `bos-system-specs/`).
- The plan mounts only `Documents/Specs` → `data/specs/user` (T011/T013), and `BuiltinSpecProvider` forces `canWrite: false` (T014/T017). There is **no VFS write path to system specs at all** under the new model.
- The plan's own Closeout (C1–C5) requires editing `bos-system-specs` (merge into 018/020/009, update `discrepancies.md`, `overview.md`) — work the new design makes impossible through the documented path.

This needs an explicit decision: either mount system specs too (e.g. `Documents/Specs` shows both stores, or a second mount), or state clearly that system-spec authoring moves to direct source edits and is out of scope. As written it's an unstated regression.

## 2. Does the spec cover all possible scenarios?

Covered well: any-app write (US1), multi-spec feature (US2), spec-only fast promote (US3), wipe survival (US4), marketplace browse/install/adopt (US5). Missing scenarios:

- **System-spec editing** (see §1).
- **Promote with merge conflict.** `promoteFeature` (T031/T039) assumes a clean merge to `main`. If `main` advanced (concurrent feature, or a re-adopted spec), the merge conflicts. No story, no error contract, no resolution path. For a spec store this is a *when*, not an *if*.
- **Pending-flush vs promote race.** Commits are debounced 2 s and "never block the caller." A promote fired within that window merges a branch that is missing the last writes. There is no "force-flush before promote" step. Silent data-lag on promote — flag given the standing no-silent-failures policy.
- **Crash inside the debounce window.** Files are on disk (working tree) but uncommitted; nothing recovers them into a commit on restart. Acceptable, but should be stated (and a startup `hasUncommitted` → commit sweep is cheap insurance).
- **Concurrent / re-entrant feature contexts.** The model assumes exactly one active context globally. Per-user containers make that mostly safe, but there's no story for "user starts feature B while A is mid-flight," nor for two browser tabs.
- **Marketplace: untrusted content.** No scenario covers a malicious/broken `marketplace.json`, a hostile git URL, or the trust model for running third-party iframe apps same-origin (see §7).
- **Uninstall / remove-marketplace / un-adopt.** `DELETE /api/marketplace/:id` exists (T026/T031) but has no user story or acceptance criteria.

## 3. Inconsistencies and use-cases that should be solved differently

### 3a. **CRITICAL — SpecFS `git checkout` collides with the Supervisor's 020 worktree model.**
This is the blocker. The plan's `GitFS.ensureBranch` does `git checkout <branch>` in the single `data/specs/user/` repo (plan §Phase 2, T008/T009). But branch-coupled specs (020) are **already implemented** via a completely different mechanism the plan neither references nor reconciles:

- `src/lib/dev/spec-fs.ts:36-48` routes writes to a **Supervisor-provisioned worktree** (`branchSpecsRoot` → `supervisorBegin`), so the base checkout is *never* switched and can render drafts from any branch without checkout.
- `tools/supervisor/supervisor.mjs` mounts store worktrees at `wt/specs/<store>` on the feature branch (lines 308–338), sets `BOS_SPECS_ROOT` per preview/base (lines 446, 638), and merges each store's feature branch on promote (lines 370–394).

The new `checkout`-in-place model directly conflicts:
- `git checkout` mutates the one working tree — it breaks "base reads drafts without checkout," and it will **fail outright** when the Supervisor holds that branch in a worktree (`fatal: '<branch>' is already checked out`). `ensureBranch`'s `checkout || checkout -b` has no handling for this.
- **The plan's task list never touches `tools/supervisor/supervisor.mjs`.** T035–T037 only edit `bastion/*` and docs. Removing `BOS_SPECS_ROOT` (T030/T037) while the Supervisor reads it in 4+ places (and derives its entire preview/promote flow from it) will break LVC. This is a large, unlisted work item.

**Recommend:** decide up front whether 027 *replaces* the Supervisor worktree-coupling (then the plan must own the Supervisor rewrite and the preview/promote story) or *layers on top of it* (then SpecFS must route to worktrees, not `checkout`). Right now it does neither and claims to "fulfil 020" while silently contradicting its implementation.

### 3b. **Reads are branch-state-dependent.** `read/list/stat` delegate to plain fs at `repoPath` (T009), i.e. whatever branch the working tree was last left on. With no active context, listing `Documents/Specs/` returns whichever half-finished branch was last checked out — not `main`. There is no read-side branch control. Reads should be pinned (e.g. via `git show <ref>:path`, the pattern already used in `store-git.ts:86-93`) rather than reflecting mutable working-tree state.

### 3c. **Two writers to `feature-context.json` → lost updates.** The client store persists the whole file via `POST /api/feature-context` (T005), while SpecFS *also* writes the file directly to append `touchedSpecs` (T009: "direct file write, not via the client store"). Concurrent whole-file-replace + append with no lock is a textbook lost-update race. Pick one writer (server-authoritative, with an atomic read-modify-write / lock), and have the client only *read* + issue intent actions.

### 3d. **Client→server context ordering race.** US1/US2 acceptance is "set context, then write." The client `setFeature` POST is fire-and-forget (plan T005), but SpecFS reads the file synchronously on the next write. A write issued immediately after setting context may hit `SpecFSNoContextError`. Needs an ordering guarantee (await the POST, or have the server run own the context for server-side agent writes).

### 3e. **Developer-agent branch wiring ignores the Supervisor (and the fragile-main-checkout hazard).** T033/T041 have the Developer agent `git checkout -b bos/feat/<id>` **in the BOS source repo**. This mutates the running `next dev` source tree and conflicts with the Supervisor's worktree+port-pool branch management. Doing a raw checkout under a running dev server swaps files mid-process, and the main checkout is known-fragile to uncommitted-work loss. This must go through the Supervisor, not raw git.

### 3f. **Always-require-context is a behavior change.** Today a write with no feature branch commits-on-save to the store default (`spec-fs.ts:151`, `store-git.ts:43`). The new model throws without a context (US1 scenario 2). That's defensible, but it breaks every existing quick-edit / API write path and needs a migration story: what creates the context for "edit one line of an existing spec that isn't a feature"? Build Studio UX for this isn't in scope anywhere.

### 3g. **`AppRegistry.listAll()` is async but native components need static imports.** `src/components/apps/registry.tsx` maps id → React component; native builtin components must be statically importable for the bundler and for SSR seed in `src/app/page.tsx`. An async registry can drive *manifests*, but the component map cannot be fully data-driven. T023/T027 gloss over this — the client component registry must remain a static import map; only iframe apps are truly dynamic.

### 3h. **Marketplace path inconsistency.** `MarketplaceSpecProvider` scans `data/specs/marketplace/<id>` (T016/T019) and `MarketplaceAppProvider` scans `data/apps/marketplace/<id>` (T022/T026), but `MarketplaceClient.addMarketplace` clones "to both, two symlinks or one clone" (T025/T030 — unresolved). And the iframe serving route (`src/app/apps/[...slug]/route.ts:19`) serves only from `appsDir()`, not `data/apps/marketplace/...`. **Installing a marketplace app has no wired serving path** — a real gap (see §4). Pin one canonical clone location and wire the `[...slug]` route (or symlink into `appsDir()`).

## 4. Does the plan cover everything that must be implemented?

Mostly, for the user-specs + provider-registry core. Notable omissions:

1. **Supervisor rewrite** (§3a) — entirely unlisted, yet load-bearing.
2. **Iframe serving for local/marketplace apps** — `src/app/apps/[...slug]/route.ts` is never modified; without it, "Install → Run" (US5) cannot serve files (§3h).
3. **`spec_edit` / find-replace path.** `FSBackend` has no `edit`; the existing `editFile` (`spec-fs.ts:156`) has no home. T014 mentions only `spec-write`. Either drop edit (read+write in the tool) explicitly, or account for it.
4. **Other `BOS_SPECS_ROOT` / `specsRoot` consumers** not in the plan's caller list: `src/lib/specs/pipeline.ts`, `src/lib/agent/skills/store.ts`, and `tools/supervisor/supervisor.mjs`. The plan names only `stores.ts`, `seed.ts`, `specs-dir.ts`, bastion. Grep before removing the env var.
5. **Force-flush-before-promote** and **startup uncommitted sweep** (§2).
6. **id → branch sanitization.** `bos/feat/<id>` must validate `id` against `^[a-z0-9-]+$` (branch names / ref injection). The existing `DRAFT_BRANCH` regex (`store-git.ts:12`) is the reference. Not specified.
7. **Marketplace git-URL validation** (protocol allowlist, no `file://`/`ext::`, SSRF) — see §7.
8. **Testing depth.** "tsc + lint per phase; no new e2e for 1–3" is thin for foundational FS routing. At minimum add unit tests for: mount path-escape (the security-critical `resolveMount`/`resolveSafe` boundary), no-context error, debounce coalescing (US1 scenario 3), and wipe-survival (US4). This is self-modifying infra where the memory-noted "high-quality code is essential" applies.

## 5. Do the tasks cover the whole plan?

The tasks are a faithful 1:1 expansion of the plan's phases (with `tsc`/lint checkpoints inserted), so they inherit the plan's gaps (§4). Additional task-level issues:

- **Numbering drift plan↔tasks.** Plan T-numbers ≠ tasks T-numbers (plan T013 `SpecProvider` = tasks T016; the inserted checkpoints shift everything). Cross-references will rot. Renumber to match, or reference by name.
- **No task for the Supervisor, the iframe route, or the extra `specsRoot` consumers** (§4.1, §4.2, §4.4).
- **No test tasks** beyond compile/lint (§4.8).
- **Closeout C1–C3 assume writable system specs** — blocked by §1 unless resolved.

## 6. Are tasks in the right order and at the right level?

Order is mostly sound (Phase 1 foundation → SpecFS → registries → marketplace → docker → promotion). Issues:

- **Promotion (Phase 7) is last, but it's core to US3 (P1).** US3 can't be validated until the very end, and `promoteFeature` depends on the branch model that §3a leaves unresolved. Promotion + the Supervisor decision should be settled in/near Phase 2, not deferred behind marketplace (P2) work.
- **Marketplace providers (T019/T026) precede the marketplace client (T030)** that creates the dirs they read. Harmless (empty results) but untestable until Phase 5 — consider folding provider + client into one phase.
- **Startup ordering** (seed `data/specs/user` before `registerMount`) is implied but not stated; make it explicit (mount needs the repo to exist).
- **Granularity is uneven.** T009 (SpecFS: context enforcement + debounce + commit + branch mgmt) and T033/T041 (Developer-agent wiring) are each large enough to be their own multi-task unit; the marketplace UI (T033) is a whole app in one checkbox. Split the heavy ones so progress is trackable and reviewable.
- **Bastion phase (6) is correctly parallelizable** but is mis-scoped: it removes `BOS_SPECS_ROOT` without the Supervisor changes that actually depend on it — those must land together or LVC breaks between phases.

## 7. Security (additional aspect — flagged)

- **Untrusted marketplace repos.** Cloning arbitrary git URLs and serving their app subtrees as **same-origin iframes** (the existing route notes apps "may call BrowserOS APIs (same-origin)", `route.ts:9-10`) means marketplace apps inherit BOS's origin privileges. There is no trust boundary, CSP, sandbox, or review step. Adopting specs is lower-risk (data), but installing apps is effectively "run this stranger's code with my session." At minimum: git-URL protocol allowlist, `marketplace.json` schema validation before any use, and a documented iframe sandboxing/CSP posture. `execFile` (not shell) is correctly implied, which avoids command injection — keep it.
- **Path-escape on the new mount boundary.** `resolveMount` + backend-relative paths add a new jailing boundary; the existing `resolveSafe` (`vfs.ts:28-36`) and app route (`route.ts:30-33`) are the reference guards. This must be unit-tested, not just compiled.

## 8. Additional observations

- **LLM commit-message diff is unbounded.** `git diff HEAD` on a large coalesced flush could blow the model's context / cost. Truncate the diff and/or cap by file count. Fallback-on-error is good.
- **`spec-store.json` writable defaults.** New user store manifest (T010) sets `writable: true` — consistent with today. Fine; just ensure the provider `canWrite` and the manifest agree (single source of truth).
- **Docs alignment.** `docs/dev/self-modification/live-version-control.md` and `docs/dev/repository-and-data-layout.md` both encode the current `BOS_SPECS_ROOT`/worktree model and must be updated as part of, not after, the Supervisor decision.

---

## Summary of required changes before implementation

**Blockers**
1. Resolve the SpecFS-vs-Supervisor branch model (§3a) — replace or layer, and own the Supervisor + LVC/promote rewrite explicitly.
2. Decide system-spec authoring path (§1) — the closeout depends on it.
3. Fix the two-writer `feature-context.json` race and the client→server ordering race (§3c, §3d).
4. Wire iframe serving for local/marketplace apps (§3h/§4.2).

**Should-fix**
5. Read-side branch pinning (§3b); force-flush before promote + merge-conflict contract (§2).
6. Developer-agent branch work via Supervisor, not raw checkout in main (§3e).
7. Marketplace trust model: URL allowlist, manifest validation, iframe sandbox/CSP (§7).
8. Add unit tests for mount path-escape, no-context error, debounce, wipe survival (§4.8).

**Nice-to-have**
9. Renumber tasks to match plan; split the heavy tasks (T009, T033/T041); move promotion earlier.
10. `id`→branch sanitization; bound the LLM diff; grep all `specsRoot` consumers before removing the env var.
