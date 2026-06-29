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
  proxies** to internal `next` instances — `active` / `next` / `previous` — each on
  its own port (`BOS_PORT_BASE`, default **3100/3101/3102**), each from its own git
  **worktree** with its own `BOS_DATA_DIR`.
- Serves a version‑independent control surface at **`/__supervisor`** (always
  reachable, even if a version's UI is broken).
- Proxies WebSocket **upgrades** (e.g. HMR) to the pinned version.

### Per-session routing (pin cookie)

`pinnedVersion(req)` reads the `bos_pin` cookie — a **role** (`next`/`previous`) or a
**branch name**. A pin is honored **only while that version is `ready`**, else it
falls back to `active` (a still‑building candidate never serves 502s). So previews
are per‑session; everyone else stays on `active`.

### Candidate lifecycle (code)

- `beginNext()` — create the `next` worktree off active's HEAD (`ensureWorktree` →
  fresh `bos/next-*` branch) + a data clone (`provisionClone`). Idempotent (reuses an
  existing candidate).
- `buildAndStart()` — commit the worktree, `npm run build`, start `next start -p
  <port>`, then **health‑gate** via `/api/health` (`waitHealthy`, ≤120s). State →
  `building` → `ready` | `failed`.
- `promote()` — **clean‑base precondition** (an in‑place edit there makes the ff‑merge
  abort), then an **escalation** instead of a hard ff requirement:
  - **FF** if the candidate already sits on base → ff‑merge.
  - **base moved under the candidate** (not a ff) + rebases cleanly (`mergeTreeConflicts`
    pre‑check, no worktree mutation) → `refreshCandidateOntoBase()`: stop the candidate,
    **rebase its worktree onto base, rebuild + re‑health‑gate** (in the background — build
    is slow; toolbar shows `building`), so a second Promote is a clean ff of built+tested
    code. The user is told it's refreshing (not a silent no‑op).
  - **rebase would conflict** → fail with the conflicting files surfaced (manual merge; the
    in‑browser 3‑way merge is a **deferred** capability).
  On a ff: **tag** (`bos/v<timestamp>`), optional push (`BOS_PUSH_MODE=auto-on-promote`),
  restart the candidate **on canonical data** (code‑only), flip routing, retain the old
  active as `previous` (drains in‑flight), discard the candidate's data clone.
- `rollback()` — flip back to `previous`.
- `discard()` — stop the candidate, remove its worktree + data clone.
- `activate(branch)` — build an **existing** branch as `next` and pin to it (the
  Topbar dropdown). Base branch → drop candidate, back to active.

### App-content candidate (GitFS, no extra port)

Apps are previewed differently — there's no second server. `appBegin/appPromote/
appDiscard` check out an `app-candidate` **branch** in the apps repo so the active
server serves it; promote merges to base, discard drops it. See
[Installed apps](../apps/installed-apps.md).

### Control endpoints (`/__supervisor/...`)

`state` · `branches` · `next-changes` · `pin` · `begin` · `build` · `activate` ·
`promote` · `rollback` · `discard` · `app-begin` · `app-promote` · `app-discard` ·
`push`. `state` also reports **`serving`** (which version the pin routes THIS
session to) so the UI can tell "previewing the candidate" from "a candidate exists
but you're still on `active`". `next-changes` lists the candidate's changed files
(committed in its worktree) so an assistant's `gitStatus` isn't fooled by a clean
main checkout.

### Key env vars

`BOS_PUBLIC_PORT`, `BOS_PORT_BASE`, `BOS_BASE_BRANCH`, `BOS_WORKTREES`,
`BOS_CANONICAL_DATA`, `BOS_DATA_CLONES`, `BOS_PUSH_MODE` (`manual` |
`auto-on-promote`), `BOS_REMOTE`, `BOS_HEALTH_TIMEOUT_MS`, `BOS_ACTIVE_REUSE_PORT`
(dev: reuse a running `npm run dev` as active).

---

## The app side (`src/lib/devharness/supervisor.ts`)

A thin client, **active only when `BOS_SUPERVISOR_URL` is set** (otherwise every
call is a no‑op → in‑place self‑modification, exactly as before):

`supervisorEnabled`, `supervisorState`, `supervisorNextChanges`, `supervisorBegin`,
`supervisorBuild`, `supervisorAppBegin/Promote/Discard`. The Claude runner uses
`begin`/`build` to provision and gate a **code** candidate, then appends a note to
the delegation result telling the user the change is a **candidate** (Preview →
Promote), not the active version; app installs use the `app-*` flow for a
**content** candidate. See [Sub‑agents](../assistant/sub-agents-and-delegation.md).
`gitStatus` (`/api/system/git`) folds in `supervisorNextChanges` so a delegated edit
shows up even though it's committed in the worktree, not the main checkout.

`src/components/desktop/VersionControls.tsx` (in the Topbar) reads
`/__supervisor/branches` + `/state` and drives `activate`/`promote`/`discard` (+ the
app candidate). A candidate built by a delegated fix is **not auto‑served**, so the
toolbar offers an explicit **Preview** (pin → reload) and a `previewing` indicator
(from `serving`); control failures (promote/discard/preview) are **surfaced inline**,
never silently swallowed. The Versions Settings tab (`self-modification` namespace,
`VersionsTab`) surfaces the same. **Push** and **rollback** are exposed on the
`/__supervisor` page.

---

## `/api/health`

`waitHealthy` polls `/api/health` (returns `{ ok: true }`) to gate a candidate
before it can be promoted. Keep this endpoint cheap and dependency‑free.

---

## Invariants for the developer agent

- Work on a **feature branch**; promote fast‑forwards it into base.
- Under the Supervisor, edit **only the candidate worktree** (the harness `cwd`).
  Editing the main checkout in place leaves it dirty, which makes a later **Promote
  fail** its clean‑base precondition. `gitStatus` reports the candidate, so a clean
  main checkout means the change is already in the candidate — don't re‑apply it.
- **Promote is code‑only** — canonical `data/` carries over; the preview clone is
  discarded. Keep `data/` schema changes **backward‑compatible** (rollback runs old
  code on the same data).
- Don't make the Supervisor depend on app internals — it's the trusted kernel.
