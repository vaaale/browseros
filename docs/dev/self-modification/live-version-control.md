# Self-modification: live version control (the Supervisor)

Spec: `specs/005-self-modification/spec.md`. User‑facing:
`docs/usage/versions/live-version-control.md`.

BOS can modify its own code **while running**. The **Supervisor** is the stable
control plane that makes this safe. It is **not** itself self‑modified.

---

## The Supervisor (`tools/supervisor/supervisor.mjs`)

A standalone, dependency‑light Node process (Node built‑ins only). Run with
`npm run supervisor`. It:

- Owns the **public port** (`BOS_PUBLIC_PORT`, default **8080**) and **reverse‑
  proxies** to internal `next start` instances. There are only two roles:
  - **BASE** — the current promoted code, **always** running on `BOS_PORT_BASE`
    (default **3000**), against canonical `data/`.
  - **PREVIEW** — at most **one** feature branch being viewed, on a port drawn from a
    pool above the base port (`BOS_PORT_BASE+1 … +BOS_PORT_POOL_SIZE`, pool size
    default **20**), against an isolated data clone.
- Serves a version‑independent control surface at **`/__supervisor`** (always
  reachable, even if a version's UI is broken).
- Proxies WebSocket **upgrades** (e.g. HMR) to the pinned version.

### Worktrees & data clones are branch-named

`base` is a singleton: a **detached** worktree at `bos-worktrees/base` checked out at
the base commit (detached so it never conflicts with the main checkout's own
checkout of `baseBranch`). A `preview` lives in a **branch‑named** worktree
(`bos-worktrees/<branch>`) with a branch‑named data clone (`bos-data-clones/<branch>`).
Keying by branch (a stable identity) rather than role keeps bookkeeping honest
across promotes and lets an orphaned preview be recovered after a restart.

### Per-session routing (pin cookie)

`pinnedVersion(req)` reads the `bos_pin` cookie — `preview` or a **branch name**. A
pin is honored **only while the preview is `ready`**; a still‑building, failed, or
**dead** preview falls back to `base` (never a 502). So previews are per‑session;
everyone else stays on `base`.

### Lifecycle (code)

- `beginPreview(branch?)` — provision (or **resume**) the preview worktree for the
  developer agent to edit. An existing `branch` is checked out **with its history**
  (continuity / resume after a Stop); a missing/absent one creates a fresh
  `bos/next-*`. Reuses the current preview when the branch matches (idempotent
  within a session). Does **not** build.
- `buildAndStart(v)` — **stop any existing server for this version first** (so a
  rebuild never collides on its port), commit the worktree, `npm run build`, start
  `next start -p <pooled port>`, then **health‑gate** via `/api/health`
  (`waitHealthy`, ≤120s). Before building, the Supervisor checks that the live
  checkout is still clean and on the base branch. If the developer harness touched
  the live checkout, the Supervisor restores it and fails the candidate instead of
  reporting a misleading ready preview. State → `building` → `ready` | `failed`.
- `activate(branch)` — toolbar selection. Base → drop the preview, back to base. An
  already‑`ready` preview of the same branch → just re‑pin. Otherwise provision +
  build in the background; the pin routes once it is `ready`.
- `dropPreview()` — **Stop**: kill its server (awaiting exit), remove its worktree +
  data clone. The **branch is kept** so the work can be resumed.
- `promote()` — **safe ordering**: do every fallible step while base still serves,
  advance the base ref **last**:
  1. Require a clean main checkout; make the preview a clean descendant of base in
     its own worktree (FF: nothing to do; non‑FF: `mergeTreeConflicts` pre‑check →
     rebase → rebuild + re‑health‑gate, else surface the conflicting files).
  2. Stop old base (**await exit**), start the candidate's code on `BOS_PORT_BASE`
     against **canonical** data, health‑gate THERE. On failure → restart the old
     base; **the base branch was never moved**.
  3. Point of no return: `git merge --ff-only` the base branch, **tag**
     (`bos/v<yyyy-mm-dd-hh_mm_ss>`), optional push
     (`BOS_PUSH_MODE=auto-on-promote`).
  4. Adopt the swapped server as base, detach its worktree off the (now‑merged)
     feature branch, delete that branch, drop the preview's data clone.
  There is **no `rollback`** action (a tag is left on every promote as a durable
  anchor for a future rollback feature).
- Boot: `reconcileWorktrees()` prunes the Supervisor's leftover worktrees from a
  previous run (their processes died with it). Branches survive, so an orphaned
  preview stays selectable from the dropdown.

### App-content candidate (GitFS, no extra port)

Apps are previewed differently — there's no second server. `appBegin/appPromote/
appDiscard` check out an `app-candidate` **branch** in the apps repo so the base
server serves it; promote merges to base, discard drops it. See
[Installed apps](../apps/installed-apps.md).

### Control endpoints (`/__supervisor/...`)

`state` · `branches` · `preview-changes` (alias `next-changes`) · `pin` · `begin` ·
`build` · `activate` · `promote` · `discard` (alias `stop`) · `app-begin` ·
`app-promote` · `app-discard` · `push`. `state` reports `base`, `preview`,
`appCandidate`, and **`serving`** (which version the pin routes THIS session to) so
the UI can tell "previewing" from "a preview exists but you're still on base".
`branches` lists **all** git branches (so an orphaned `bos/*` preview can be
re‑selected). `preview-changes` lists the preview's changed files (committed in its
worktree) so an assistant's `gitStatus` isn't fooled by a clean main checkout.

### Key env vars

`BOS_PUBLIC_PORT` (supervisor, default 8080), `BOS_PORT_BASE` (base, default 3000),
`BOS_PORT_POOL_SIZE` (preview ports above base, default 20), `BOS_BASE_BRANCH`,
`BOS_WORKTREES`, `BOS_CANONICAL_DATA`, `BOS_DATA_CLONES`, `BOS_PUSH_MODE` (`manual` |
`auto-on-promote`), `BOS_REMOTE`, `BOS_HEALTH_TIMEOUT_MS`, `BOS_ACTIVE_REUSE_PORT`
(dev: reuse a running `npm run dev` as base). The Supervisor passes
`BOS_CANONICAL_DATA` to every child so cross‑version state (the conversation→branch
map) persists to canonical data even from a preview's throwaway clone.

---

## The app side (`src/lib/devharness/supervisor.ts`)

A thin client, **active only when `BOS_SUPERVISOR_URL` is set** (otherwise every
call is a no‑op). Source-edit developer harness runs refuse to proceed without the
Supervisor, so BOS never falls back to in-place self-modification of the live
checkout:

`supervisorEnabled`, `supervisorState`, `supervisorNextChanges` (→ `preview-changes`),
`supervisorBegin(branch?)`, `supervisorBuild`, `supervisorAppBegin/Promote/Discard`.
The Claude runner (`claude-runner.ts`) uses `begin`/`build` to provision and gate a
**code** preview, then appends a note telling the user the change is a **preview**
(Preview → Promote), not the base; app installs use the `app-*` flow for a
**content** candidate. See [Sub‑agents](../assistant/sub-agents-and-delegation.md).
`gitStatus` (`/api/system/git`) folds in `supervisorNextChanges` so a delegated edit
shows up even though it's committed in the worktree, not the main checkout.

### Branch continuity (one branch key ↔ one feature branch)

A delegated dev task is anchored by an **opaque branch key** so repeated work —
"improve the thing we worked on" — continues on the **same** branch even after a Stop
dropped the preview. The key is any stable string the caller picks: a chat's
conversation id, a workflow id, an external `gitlab-issue:1234`, etc.
(`getBranchForKey`/`setBranchForKey` in `src/lib/devharness/thread-branches.ts`,
stored under canonical `data/devharness/thread-branches.json`; one flat namespace, so
prefix external ids).

- **Resolution** (`claude-runner.ts`): the key's remembered branch, else a fresh
  `bos/next-*`. Source edits without a key are refused. An **interactive**
  caller additionally lets a currently‑**previewed** branch win first ("improve what
  I'm viewing"); a **headless** caller's key is **authoritative** and never adopts a
  human's stray live preview.
- **Who supplies it:** the chat sends its conversation id + `interactive:true`
  (`SubAgentActions`); the workflow runner sends `workflow:<id>` (or a per‑run
  override) headless; any integration POSTs its own id — `/api/subagents/delegate`
  (`branchKey`, legacy alias `threadId`, optional `interactive`) or `/api/workflows/run`
  (`branchKey`).
- Promote deletes the merged branch, so the next run on that key resolves to a fresh
  branch off the new base (the anchor self‑heals — `provisionPreview` re‑creates a
  missing branch off base).

### UI

`src/components/desktop/VersionControls.tsx` (Topbar) reads `/__supervisor/branches`
+ `/state` and drives `activate`/`promote`/`discard`(=Stop) (+ the app candidate). A
preview built by a delegated fix is **not auto‑served**, so the toolbar offers an
explicit **Preview** (pin → reload) and a `previewing` indicator (from `serving`);
**Stop** kills + cleans the preview (branch kept) and returns to base. Control
failures are **surfaced inline**, never silently swallowed. The Versions Settings tab
(`self-modification` namespace, `VersionsTab`) surfaces the same. **Push** is exposed
on the `/__supervisor` page.

---

## `/api/health`

`waitHealthy` polls `/api/health` (returns `{ ok: true }`) to gate a version before
it serves / is promoted. Keep this endpoint cheap and dependency‑free.

---

## Invariants for the developer agent

- Work on a **feature branch**; promote fast‑forwards it into base.
- Under the Supervisor, edit **only the preview worktree** (the harness `cwd`).
  Editing the main checkout in place leaves it dirty, which makes a later **Promote
  fail** its clean‑base precondition. `gitStatus` reports the preview, so a clean
  main checkout means the change is already in the preview — don't re‑apply it.
- **Promote is code‑only** — canonical `data/` carries over; the preview clone is
  discarded. Keep `data/` schema changes **backward‑compatible**.
- Don't make the Supervisor depend on app internals — it's the trusted kernel.
