# BrowserOS GitFS — Versioned-Content Layer — Specification

GitFS is the storage layer for **versioned, user-authored, shareable content** — installed **apps** today, and **workflows** (and possibly docs/skills) later. It is the third storage layer in BOS, distinct from the other two:

- **BOS source code** → git worktrees of the BOS repo, driven by the Supervisor (`spec/self-modification/self-modification.md`). Code-only promote.
- **Runtime state** (settings, memory, VFS scratch, provider config, MCP list) → **DataFS** (`spec/self-modification/datafs.md`). Throwaway preview-clone isolation, no merge.
- **Versioned content** (apps, workflows) → **GitFS** (this document). Its own git repo, real history/merge, marketplace-ready.

### The line between DataFS and GitFS
One question decides it: **"Does this data need proper versioning?"**
- **Yes** (user-authored content with a history you'd want to revert / branch / share — apps, workflows) → **GitFS**.
- **No** (evolving runtime state where only the latest value matters — settings, memory, scratch) → **DataFS**.
Shareability (the marketplace) is the single strongest GitFS signal. Equivalent test: *"is git the right tool?"* — git suits low-churn, durable, shareable content; it is wrong for high-churn, concurrent, large/binary, or secret-bearing runtime state (which is why "git all the way" is explicitly rejected: git-worktree isolation only shares *committed* content, which would force committing churning + secret runtime state).

---

## 1. Principles

- **Content lives in its OWN git repo, independent of the BOS source repo.** This is the linchpin: a user's apps must never collide with upstream BOS changes. Because they are a *separate repository* (not a subdirectory of the BOS repo, and **not a git submodule** — a submodule would push a gitlink pointer + churn/conflicts back into the BOS repo), `git pull` on the BOS source tree can never conflict with user content.
- **Configurable root, gitignored by default.** The content root is resolvable from an environment variable (`BOS_APPS_DIR`, defaulting to `<cwd>/apps`). When it sits inside the BOS working tree (the default), it MUST be gitignored there so the nested content repo is invisible to the BOS source repo.
- **Discovery, not a registry.** Content is found by **listing the content directory** — each item is a self-contained, self-describing folder. There MUST be no central registry file that both a user and upstream would edit (that is exactly the merge hazard GitFS exists to avoid). A self-contained folder is also the natural unit for a marketplace.
- **Git is the versioning + distribution substrate.** History, branching, and merge are git's; a community **marketplace** maps directly onto git remotes (install = clone/pull, publish = push, update = pull).
- **Decoupled from the code-candidate flow.** Content versioning is orthogonal to BOS-code self-modification. Building an app is a *content* operation; it does NOT spin up a BOS-code candidate worktree. (Code and content candidates are independent and may both be in flight.)

---

## 2. The GitFS module (interface)

A server-only module exposing git operations against a configured content root:
- `ensureRepo(root)` — create the dir and `git init` if it is not already its own repo (checked via `<root>/.git`, never `git rev-parse`, so it can never accidentally operate on an enclosing repo); seed an initial commit so branches/merges have a base.
- `commitAll(root, message)` — stage all and commit; no-op when clean. A local committer identity is supplied so commits never fail on a machine with no global git config.
- `history(root, relPath?, limit?)` — commit log for the repo or one item (for a per-item version/revert UI).
- Reads/writes are ordinary filesystem operations under `root`; mutations are followed by `commitAll`.

**Implemented:** `src/lib/gitfs/store.ts`.

---

## 3. Apps as GitFS content (the first consumer)

- The apps root is `appsDir()` (`src/os/apps-dir.ts`): `BOS_APPS_DIR` or `<cwd>/apps`. It is a standalone git repo.
- **No `installed-apps.json` registry.** Each app is `<appsDir>/<id>/` containing its files (entry `index.html`) plus an `app.json` manifest (`name, icon, createdAt, status, uninstalledAt?`). Apps are discovered by listing the directory.
- **Served** at `/apps/<id>/…` by `src/app/apps/[...slug]/route.ts`, reading from `<appsDir>/<id>` with a path-escape jail (it reads the filesystem directly, so the jail is load-bearing). HTML gets a `<base href="/apps/<id>/">` injected so relative URLs resolve.
- **Lifecycle** (`src/lib/apps/store.ts`), each step committed to GitFS: `installApp` (write files + `app.json`, commit), `uninstallApp` (soft — `status:"uninstalled"`, keeps files), `restoreApp`, `purgeApp` (remove dir). `listInstalledManifests()` returns only installed apps for the desktop (SSR-seeded in `src/app/page.tsx`).

**Implemented.**

---

## 4. Candidate preview / promote / discard (IMPLEMENTED — branch-live)

App candidates are **git branches** in the content repo (`app-candidate`), not worktrees + a second server. Because the active BOS serves the content repo's working tree, checking out the candidate branch makes the in-progress app immediately visible — "branch-live" preview — with no extra port, proxy, or rebuild. This is orthogonal to the BOS-code candidate flow.

- **Begin** (`POST /__supervisor/app-begin`): ensure the repo, then create/checkout the `app-candidate` branch off the current (base) branch. Driven by the Supervisor; called by `installApp({...}, { draft:true })` before it writes, so a drafted install lands on the candidate. The active server now serves the candidate (preview).
- **Promote** (`POST /__supervisor/app-promote`): checkout base, `git merge --no-edit app-candidate`, delete the branch. The app goes live on base. Unlike DataFS, GitFS promote **does** integrate (it's git content, not throwaway runtime state).
- **Discard** (`POST /__supervisor/app-discard`): `checkout -f` base and delete the branch (`-D`); the candidate's commits are dropped and the working tree reverts — app gone.
- **State**: `/__supervisor/state` includes `appCandidate: { branch, base } | null`; the Topbar (`VersionControls`) shows it with **Promote app** / **Discard app**.

The Developer sub-agent that builds the app's HTML is delegated with **`contentOnly: true`** (`delegateToSubAgent`), so it runs in-place and does **not** provision a BOS-code candidate worktree — the result is installed via `installApp` onto the app-candidate branch.

**Trade-off / note:** branch-live preview is a single shared view (the working tree is on the candidate branch), not per-session isolation. That is sufficient for single-user dev. True per-session isolation (a separate content worktree served only to pinned sessions, e.g. via a Supervisor-injected apps-dir header) remains a future option. Outside the Supervisor, `draft` is a no-op and apps install live (history/revert via `uninstall`/`purge`).

---

## 5. Future

- **Generalize beyond apps**: workflows (and maybe docs/skills) become GitFS content "kinds"; workflow versioning is then the same machinery.
- **FS registry**: an app declares the storage *kind* it needs at registration and BOS provisions + tracks it (ownership ledger → clean uninstall/GC). A small common core interface + queryable per-backend capabilities (history/branch on GitFS; encrypt/rotate on a future SecFS). Each FS kind declares its preview/isolation behavior the Supervisor consults.
- **Marketplace**: community apps distributed as git repos; install/update/publish = clone/pull/push.
- **SecFS** (separate, later): an encrypted store for secrets (e.g. `provider.json`), with an explicit threat model, vetted crypto, an external master key, and per-app scoping. Out of scope here.

---

## 6. Relationship to other specs

- **`spec/self-modification/self-modification.md`** — the control plane (BOS-code candidates). GitFS content candidates are an independent, parameterized use of the same Supervisor machinery.
- **`spec/self-modification/datafs.md`** — the runtime-state data plane. GitFS holds what DataFS explicitly does not version; apps were removed from DataFS's scope when they moved here.
- **`spec/bos.md`** — apps are GitFS content created via the Developer sub-agent + `installApp`.
