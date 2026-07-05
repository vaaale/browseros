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
  - **PREVIEW** — zero or more feature branches can be built/running at the same
    time, each on a port drawn from a pool above the base port (`BOS_PORT_BASE+1 …
    +BOS_PORT_POOL_SIZE`, pool size default **20**) against an isolated data clone.
    A browser session views at most one preview at a time via its pin cookie.
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

### Spec stores are branch-coupled (020)

One feature = **one branch name across the BOS repo and every spec store**. On
provision/restore, each store under `BOS_SPECS_ROOT` is mounted into the code
worktree at `specs/<store>/` as a **git worktree of that store** checked out on
the same `bos/<feature>` branch (created off the store's default when missing).
Real directories — no symlink for Turbopack to trip on — and new files reach the
canonical store through commits (shared object DB/refs). The BOS repo gitignores
`specs/`, so the candidate `git add -A` never stages the mounts. The Supervisor
commits the store worktrees whenever it commits the code worktree; promote
merges each store's feature branch into its default (after a `merge-tree`
pre-check that runs **before** the code promote's point of no return); discard
deletes the store branches. Version servers get an explicit spec root:
previews `<worktree>/specs` (+ `BOS_SPECS_SEED=0` — seeding is base's job),
base the canonical `BOS_SPECS_ROOT`. Base renders in-progress drafts from the
store refs (Build Studio draft nodes), so spec work is visible without
previewing the branch.

### Per-session routing (pin cookie)

`pinnedVersion(req)` reads the `bos_pin` cookie — `preview` or a **branch name**. A
pin is honored **only while the preview is `ready`**; a still‑building, failed, or
**dead** preview falls back to `base` (never a 502). So previews are per‑session;
everyone else stays on `base`.

### Lifecycle (code)

- `beginPreview(branch)` — provision (or **resume**) the preview worktree for the
  developer agent to edit. `branch` is mandatory and must match
  `bos/<kebab-name>` with one to four lowercase dash-separated segments. An
  existing branch is checked out **with its history**; a missing branch is created
  off base. (Re)mounts the spec-store worktrees on the same branch. Does **not**
  build.
- `buildAndStart(v)` — **stop any existing server for this version first** (so a
  rebuild never collides on its port), commit the spec-store worktrees + the code
  worktree, `npm run build`, start
  `next start -p <pooled port>`, then **health‑gate** via `/api/health`
  (`waitHealthy`, ≤120s). Before building, the Supervisor checks that the live
  checkout is still clean and on the base branch. If the developer harness touched
  the live checkout, the Supervisor restores it and fails the candidate instead of
  reporting a misleading ready preview. State → `building` → `ready` | `failed`.
- `activate(branch)` — toolbar selection. Base clears the pin. An already-`ready`
  preview can be pinned immediately by the UI; missing/not-built/stopped previews
  are provisioned and built in the background while the current request keeps
  serving base.
- `stopPreview(branch)` — **Stop**: kill its server (awaiting exit) but keep the
  worktree, data clone, and feature branch so the work can be resumed.
- `discardPreview(branch)` — **Discard**: kill the server, remove worktree + data
  clone, and delete the feature branch — in the BOS repo **and** every spec store.
  Promote also destroys the preview after the branch is merged.
- `promote()` — **safe ordering**: do every fallible step while base still serves,
  advance the base ref **last**:
  1. Require a clean main checkout; commit + `merge-tree`-pre-check the spec-store
     branches (a spec conflict fails the promote here); make the preview a clean descendant of base in
     its own worktree (FF: nothing to do; non‑FF: `mergeTreeConflicts` pre‑check →
     rebase → rebuild + re‑health‑gate, else surface the conflicting files).
  2. Stop old base (**await exit**), start the candidate's code on `BOS_PORT_BASE`
     against **canonical** data, health‑gate THERE. On failure → restart the old
     base; **the base branch was never moved**.
  3. Point of no return: `git merge --ff-only` the base branch, **tag**
     (`bos/v<yyyy-mm-dd-hh_mm_ss>`), optional push
     (`BOS_PUSH_MODE=auto-on-promote`).
  4. Adopt the swapped server as base, merge each spec store's feature branch into
     its default (dropping the store branch), detach the worktree off the
     (now‑merged) feature branch, delete that branch, drop the preview's data clone.
  There is **no `rollback`** action (a tag is left on every promote as a durable
  anchor for a future rollback feature).
- Boot: `reconcileWorktrees()` prunes the Supervisor's leftover worktrees from a
  previous run (their processes died with it), then `restorePreviews()` scans
  `bos/*` branches and recreates branch-owned preview records as `not-built`.
  Runtime state is reconstructed, not persisted.

### App-content candidate (GitFS, no extra port)

Apps are previewed differently — there's no second server. `appBegin/appPromote/
appDiscard` check out an `app-candidate` **branch** in the apps repo so the base
server serves it; promote merges to base, discard drops it. See
[Installed apps](../apps/installed-apps.md).

### Control endpoints (`/__supervisor/...`)

`state` · `branches` · `preview-changes` (alias `next-changes`) · `logs` · `pin` ·
`begin` · `build` · `activate` · `promote` · `stop` · `discard` · `app-begin` ·
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
`BOS_CANONICAL_DATA` to every child so code can find canonical runtime data when a
preview is running from a throwaway clone.

---

## The app side (`src/lib/devharness/supervisor.ts`)

A thin client, **active only when `BOS_SUPERVISOR_URL` is set** (otherwise every
call is a no‑op). Source-edit developer harness runs refuse to proceed without the
Supervisor, so BOS never falls back to in-place self-modification of the live
checkout:

`supervisorEnabled`, `supervisorState`, `supervisorNextChanges(branch)` (→
`preview-changes`), `supervisorBegin(branch)`, `supervisorBuild(branch)`,
`supervisorAppBegin/Promote/Discard`.
The Claude runner (`claude-runner.ts`) uses `begin`/`build` to provision and gate a
**code** preview, then appends a note telling the user the change is a **preview**
(Preview → Promote), not the base; app installs use the `app-*` flow for a
**content** candidate. See [Sub‑agents](../assistant/sub-agents-and-delegation.md).
`gitStatus` (`/api/system/git`) folds in `supervisorNextChanges` so a delegated edit
shows up even though it's committed in the worktree, not the main checkout.

### Active feature branch

A delegated dev task is owned by an explicit feature branch, not an opaque branch
key. Assistant conversations persist `activeFeatureBranch` in
`data/vfs/Documents/Chats/<id>.json`; the Assistant app header exposes an **Active
feature branch** selector plus a `New feature branch...` action. Branch creation is
server-side and enforces `bos/<kebab-name>` (one to four lowercase dash-separated
segments).

`runClaudeAgent` refuses source edits unless the caller has resolved a valid active
feature branch. The public LLM tool schema does **not** accept a branch parameter;
`/api/subagents/delegate` resolves it server-side from the current conversation, and
automation can pass a validated `featureBranch` directly to workflow/delegate
server APIs. With no active branch, the harness fails before Claude/OpenCode/MCP is
spawned, so it cannot edit the running checkout by accident.

### UI

`src/components/desktop/VersionControls.tsx` (Topbar) reads `/__supervisor/branches`
+ `/state` and drives branch-owned `activate`/`pin`/`stop`/`discard`/`promote`
(+ the app candidate). The topbar shows a prominent centered **BASE** or
**PREVIEW** marker and a dropdown containing the actual base branch name plus all
git branches. Selecting a non-running feature branch immediately shows
`building <branch>...` and disabled controls while the build runs; selecting an
already-ready preview switches to it immediately. **Stop** stops the preview server
but keeps branch/worktree. **Discard** deletes the branch/worktree. **Promote** is
available for stopped/not-built previews and builds first if needed. A **Log** button
opens recent Supervisor logs. Control failures are **surfaced inline**, never
silently swallowed. The Versions Settings tab (`self-modification` namespace,
`VersionsTab`) surfaces the same branch-owned operations. **Push** is exposed on the
`/__supervisor` page.

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
