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
- `promote()` — **ff‑merge** the candidate commit into the base branch, **tag**
  (`bos/v<timestamp>`), optional push (`BOS_PUSH_MODE=auto-on-promote`), restart the
  candidate **on canonical data** (code‑only), flip routing, retain the old active as
  `previous` (drains in‑flight), discard the candidate's data clone.
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

`state` · `branches` · `pin` · `begin` · `build` · `activate` · `promote` ·
`rollback` · `discard` · `app-begin` · `app-promote` · `app-discard` · `push`.

### Key env vars

`BOS_PUBLIC_PORT`, `BOS_PORT_BASE`, `BOS_BASE_BRANCH`, `BOS_WORKTREES`,
`BOS_CANONICAL_DATA`, `BOS_DATA_CLONES`, `BOS_PUSH_MODE` (`manual` |
`auto-on-promote`), `BOS_REMOTE`, `BOS_HEALTH_TIMEOUT_MS`, `BOS_ACTIVE_REUSE_PORT`
(dev: reuse a running `npm run dev` as active).

---

## The app side (`src/lib/devharness/supervisor.ts`)

A thin client, **active only when `BOS_SUPERVISOR_URL` is set** (otherwise every
call is a no‑op → in‑place self‑modification, exactly as before):

`supervisorEnabled`, `supervisorState`, `supervisorBegin`, `supervisorBuild`,
`supervisorAppBegin/Promote/Discard`. The Claude runner uses `begin`/`build` to
provision and gate a **code** candidate; app installs use the `app-*` flow for a
**content** candidate. See [Sub‑agents](../assistant/sub-agents-and-delegation.md).

`src/components/desktop/VersionControls.tsx` (in the Topbar) reads
`/__supervisor/branches` + `/state` and drives `activate`/`promote`/`discard` (+ the
app candidate). The Versions Settings tab (`self-modification` namespace,
`VersionsTab`) surfaces the same. **Push** and **rollback** are exposed on the
`/__supervisor` page.

---

## `/api/health`

`waitHealthy` polls `/api/health` (returns `{ ok: true }`) to gate a candidate
before it can be promoted. Keep this endpoint cheap and dependency‑free.

---

## Invariants for the developer agent

- Work on a **feature branch**; promote fast‑forwards it into base.
- **Promote is code‑only** — canonical `data/` carries over; the preview clone is
  discarded. Keep `data/` schema changes **backward‑compatible** (rollback runs old
  code on the same data).
- Don't make the Supervisor depend on app internals — it's the trusted kernel.
