# Feature Specification: External Spec Stores (System + User)

**Feature Branch**: `018-external-spec-store`

**Created**: 2026-07-02

**Status**: Draft

**Input**: "Move specifications out of the BOS source tree into independent git repositories under one container root (`BOS_SPECS_ROOT`) — each store a subdirectory that is its own repo (a BOS-owned **system** store, a user-owned **user** store, and future marketplaces) — so specs are the distributable source of truth (SAAP), the BOS source repo stays pristine, and specs are versioned like content (edit-in-place, build-free promote) rather than like code. Stores are directory-auto-discovered and self-describing (per-store manifest); Build Studio renders one group per store."

> Fourth application of the storage-layer split: specs join apps/workflows (`007-gitfs`) as versioned, shareable **content** in their own repos — distinct from BOS source-code worktrees (`005-self-modification`) and DataFS runtime state (`006-data-isolation`). Supersedes the assumption in `001-build-studio` / `013-build-studio-agentic` that specs live at `specs/` inside the BOS source tree.

## Why this exists (context)

Today specs are authored by Build Studio and agents into `specs/` **inside the BOS source repo** via `spec-fs.ts` (rooted at `process.cwd()`), and they are never committed — so new specs sit as untracked files that pollute the source tree, and any attempt to version a system-spec change collides with the code path.

Routing spec changes through the **code** self-modification path (`005`) is the wrong tool: that machinery (isolated worktree + `npm run build` + preview server + promote) exists to protect the **running code** from in-flight edits. Specs are **inert documents** — nothing imports or executes them — so they need none of it. Forcing them through the code path also means a user could not see or work on an in-progress spec unless they were actively *previewing* that feature branch, which disqualifies it.

The right model is the one BOS already uses for other inert content (installed apps, `007-gitfs`): each spec store is an **independent git repo**, edited **in place**, versioned via a candidate branch, and promoted by a **build-free git merge**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Specs never collide with BOS upstream (Priority: P1)

Specifications live in their own git repos (not a subdirectory of the BOS repo, not a submodule), so a `git pull` on BOS source can never conflict with a user's specs, and BOS ships/updates its system specs without touching the user's.

**Why this priority**: The core SAAP + storage-hygiene goal; everything else builds on the stores existing independently.

**Independent Test**: Update the BOS source repo while local system and user specs exist; confirm no conflict with either store.

**Acceptance Scenarios**:

1. **Given** a system spec store and a user spec store, **When** the BOS source repo is updated, **Then** neither store conflicts and the BOS working tree shows no spec files.
2. **Given** a nested store location, **When** BOS is committed, **Then** the store is gitignored and never tracked by the BOS repo.

### User Story 2 - I can work on specs from the normal Build Studio (Priority: P1)

A user (or agent) creates and edits specs in place from their normal Build Studio session — no preview session, no build, no developer round-trip for authoring.

**Why this priority**: This is the workflow failure that motivated the redesign — specs must be editable from the running environment.

**Independent Test**: Author and edit a spec in the running BS app; confirm the change is visible immediately in the same session without previewing any branch.

**Acceptance Scenarios**:

1. **Given** the BS app running on the base version, **When** the user edits a spec, **Then** the edit is visible immediately in that session.
2. **Given** an in-progress spec, **When** the user reloads BS, **Then** the in-progress content persists (committed to the store) without a promote.

### User Story 3 - Build Studio shows System and User specs as two groups (Priority: P1)

The BS spec tree presents specs grouped by store — **System specs** (BOS-owned) and **User specs** (user-owned) — via one spec filesystem with multiple roots and one set of tools (no separate per-store tools).

**Why this priority**: The primary UI expression of the split; required for users to find and disambiguate specs.

**Independent Test**: Open BS; confirm both groups render, each listing the specs from its store.

**Acceptance Scenarios**:

1. **Given** both stores populated, **When** BS loads, **Then** the tree shows a System group and a User group with their respective specs.
2. **Given** a spec in a store, **When** the user reads it, **Then** it is served from that store regardless of group.

### User Story 4 - System specs stay editable, but changes are versioned via promote (Priority: P2)

System specs remain fully editable, but a change is not "live" until promoted: edits accumulate on a candidate branch in the system store and are promoted by a build-free git merge (with extra scrutiny for the constitution). User-store edits are freer (commit-on-save).

**Why this priority**: Preserves the ability to modify BOS-owned specs while keeping them under review — without the code preview/promote tax.

**Independent Test**: Edit a system spec, confirm it is staged on the candidate branch, then promote and confirm it merged to the store's main branch with no build step.

**Acceptance Scenarios**:

1. **Given** a system-spec edit, **When** it is saved, **Then** it lands on the store's candidate branch, not its main branch.
2. **Given** a system-spec candidate, **When** the user promotes, **Then** it merges to main via `git merge` with no build and no preview server.
3. **Given** a change to the constitution, **When** promote is requested, **Then** the agent applies extra scrutiny (per the constitution rule) before merging.

### User Story 5 - The developer can read the spec it is implementing (Priority: P2)

When implementation is delegated to the developer harness, the relevant spec store is mounted **read-only** into the code preview worktree, so the harness can read the spec (and constitution) even though specs no longer live in the BOS source tree.

**Why this priority**: Closes the "harness can't see the spec" seam that the isolated worktree otherwise creates.

**Independent Test**: Delegate implementation of a spec; confirm the harness can read the spec content from its working directory and cannot write to the mounted store.

**Acceptance Scenarios**:

1. **Given** a delegated implementation, **When** the harness reads the spec path, **Then** it sees the current store content.
2. **Given** the mounted store, **When** the harness attempts to write to it, **Then** the write is rejected (read-only) and code edits still target the worktree.

### User Story 6 - Additional spec marketplaces plug in (Priority: P3)

Because a store is just an independent git repo dropped into the specs root, additional spec stores ("marketplaces") plug in by **cloning a repo into a new subdirectory** — no config change — and appear as further groups in BS; install/publish maps to git clone/push/pull, like the app marketplace vision.

**Why this priority**: Forward-looking; not required for v1 but the design must not preclude it.

**Independent Test**: Clone a third store repo into `BOS_SPECS_ROOT`; confirm it is auto-discovered as its own group and its specs are readable.

**Acceptance Scenarios**:

1. **Given** a third store repo cloned under the specs root, **When** BS loads, **Then** it appears as an additional group (labelled from its manifest) with no config or code change.

### Edge Cases

- `BOS_SPECS_ROOT` is a plain container; each **store** MUST be detected via `<root>/<store>/.git` (never `git rev-parse`), so an operation can never act on the container or an enclosing repo (same guard as `007-gitfs`).
- A subdirectory under the root **without** `.git` or **without** a store manifest MUST be ignored (not treated as a store).
- First run with no system store MUST seed the system-store subdirectory from the shipped bundle; a subsequent BOS update that adds a new system spec MUST add it without clobbering user edits to existing system specs (additive ensure-exists).
- Reading spans all stores; a write MUST be addressed by store id (which subdirectory), never guessed; writes to a store whose manifest is not `writable` (e.g. a marketplace) MUST be refused.
- Outside the Supervisor, spec promote is a plain merge in the store repo (no Supervisor involvement); stores still work with `next dev`.
- The migration MUST preserve existing spec history (git) and repoint every `specs/` / `.specify/memory/` reference (code, `CLAUDE.md`, docs) to the store roots.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Specifications MUST live in **independent git repos**, not tracked subdirectories of the BOS source repo and NOT submodules; gitignored when nested. All stores sit under a single configurable **container root** `BOS_SPECS_ROOT` (default `<cwd>/specs`), where **each store is a subdirectory that is its own independent git repo** (`<root>/bos-system-specs/.git`, `<root>/user-specs/.git`, …). `BOS_SPECS_ROOT` itself is a **plain container directory, NOT a git repo** — so the nested store repos are never submodules/gitlinks and the container never accidentally tracks them. There MUST be at least a BOS-owned **system** store and a user-owned **user** store; they are separate repos (not one namespaced repo) because ownership differs — system specs belong to BOS, user specs belong to the user — and independent repos make additional marketplaces (each its own repo) a natural extension.
- **FR-002**: Stores MUST be discovered by **listing `BOS_SPECS_ROOT`** (each subdirectory with a `<subdir>/.git` is a store) — there MUST be **NO central store-registry file** (same directory-auto-discovery rule as installed apps). Each store MUST be a **self-describing folder**: a manifest at its root declares `{ label, owner: "system" | "user" | "marketplace", writable, requiresPromote }`. A store's **role and policy come from its manifest, not from its directory name or an env var** (so a cloned marketplace repo brings its own identity); a subdirectory lacking `.git` or a manifest MUST be ignored. Exactly one store SHOULD declare `owner: "user"` (the default write target for new user specs) and one `owner: "system"`.
- **FR-003**: `spec-fs` MUST become **multi-root**: reads span all registered stores (addressed by store id + relative path); writes target the addressed store. It MUST keep the existing jail semantics (path-escape refusal, size caps, text-search) per store root. The spec-kit **engine** (`.specify/templates/`, scripts) STAYS in the BOS source tree; only spec **content** (per-feature specs, `overview.md`, `discrepancies.md`, and the **constitution** at `.specify/memory/constitution.md`) moves to the system store.
- **FR-004**: Specs MUST be versioned as **content, not code** — edited **in place** (visible in the running BS session with no preview and no build), with changes committed to the store repo. Spec changes MUST NOT use the code self-modification path (`005`): no isolated build worktree, no `npm run build`, no preview server for a spec change.
- **FR-005**: The **promote** model MUST mirror `007-gitfs` app candidates: system-store edits land on a **candidate branch** and are promoted by a **build-free `git merge`** to the store's main branch (no build, no preview port), then the candidate is cleared; a failed/abandoned change is discarded by dropping the candidate. The **user** store MAY commit-on-save (no candidate step) since its content is user-owned and low-risk. A **constitution** change MUST trigger extra scrutiny before promote (constitution rule from `013`).
- **FR-006**: The tooling MUST use **one set of spec tools** regardless of store (no separate per-store tools, per user decision); the system/user distinction is enforced at the **versioning/promote policy** layer (`requiresPromote`, branch protection), not by different tools or code paths.
- **FR-007**: On implementation delegation, the store(s) the harness needs (the one containing the target spec, plus the system store for the constitution) MUST be mounted into the code preview worktree at the **natural in-worktree path** `specs/<store>/…` — the same explicit paths the harness would read pre-migration — NOT behind an env var it must dereference (explicit paths avoid the "file not found" flailing that indirection invites). Because the BOS repo gitignores the `specs/` container path (FR-010), the mount is **automatically excluded** from `git add -A` in the candidate build, so harness edits to the copy are inert (never committed onto the code branch, never propagated back to the store) — read-only in effect without env vars or special perms. The mount MUST be refreshed on worktree reuse so an edited spec is current. This replaces reading specs from the BOS source working tree, and generalizes to any future external content root the harness must read (e.g. `docs/` if it ever moves).
- **FR-008**: BOS MUST **seed** the system store on first run from a tracked seed bundle shipped in the BOS distribution (analogous to seeded agents/skills/apps), and MUST apply **additive ensure-exists** updates on later BOS versions so new/updated system specs arrive without clobbering user edits to existing ones.
- **FR-009**: The Build Studio app MUST present specs as **one group per store** — the group label is the store manifest's `label` (falling back to the subdirectory name) — reusing the existing spec-tree UI and the `/api/specs` route extended with a store dimension. New stores (marketplaces) MUST appear as new groups automatically from discovery, with no BS code change.
- **FR-010**: The migration MUST remove `specs/` (and the constitution under `.specify/memory/`) from BOS source tracking, repurpose/point `BOS_SPECS_ROOT` at the container dir (gitignored when nested), preserve git history, seed the system store subdirectory from the migrated content, and repoint every reference — `spec-fs` root, repo-fs `WRITE_ALLOW_PREFIXES`, `CLAUDE.md`, and `docs/` — to the store roots. (Default `BOS_SPECS_ROOT` reuses the `<cwd>/specs` path the in-tree specs occupy today; because the old tracked `specs/` is removed from the BOS repo and gitignored, the same path now serves as the store container — verify no stale tracked files remain.)

### Key Entities *(include if feature involves data)*

- **Specs root** — the single container directory (`BOS_SPECS_ROOT`); a plain folder holding the store repos, not a repo itself.
- **Spec store** — a subdirectory under the root that is its own independent git repo of spec content.
- **Store manifest** — the self-describing file at a store's root declaring `{ label, owner, writable, requiresPromote }`; the source of a store's role/policy (discovery, not a central registry).
- **System spec store** — the store whose manifest is `owner: system`; seeded + updated from the shipped bundle; changes require promote.
- **User spec store** — the store whose manifest is `owner: user`; freely writable (commit-on-save); default target for new user specs.
- **Spec candidate branch** — the build-free preview/promote unit within a store (mirrors `app-candidate`).
- **Read-only store mount** — the spec store exposed to the developer worktree at implement time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A `git pull` on the BOS source repo never produces a conflict involving spec content, and the BOS working tree contains no spec files.
- **SC-002**: A user can create and edit a spec from the running BS app and see the change immediately, with zero build steps and no preview session.
- **SC-003**: Promoting a spec change completes as a git merge with no `npm run build` invocation and no preview server started.
- **SC-004**: A delegated implementation can read its target spec from the harness working directory, and a write attempt to the mounted store fails.
- **SC-005**: A fresh install seeds all system specs; a simulated BOS update adds a new system spec without overwriting a locally edited system spec.
- **SC-006**: Cloning a third store repo into `BOS_SPECS_ROOT` surfaces it as a new BS group with readable specs, with no config change and no code change to the store interface.

## Assumptions

- Single-user, local BOS instance (consistent with the rest of BOS); no multi-user concurrent editing of a store.
- One container root (`BOS_SPECS_ROOT`, default `<cwd>/specs`) holds all store repos as subdirectories; relocatable via config, matching `BOS_APPS_DIR` / `BOS_DATA_DIR` conventions. The container is gitignored when nested in the BOS tree; it is not itself a git repo.
- The spec-kit engine (templates, command prompts, scripts) remains BOS tooling in the source tree; only spec content and the constitution migrate.
- `docs/` is the same class of content and could adopt this pattern later, but is **out of scope** for this feature.
- The read-only store mount reuses the Supervisor worktree-provisioning pattern (a copy/reflink or read-only bind), consistent with `hydrateWorktree`.
- This spec is authored in-tree at `specs/018-external-spec-store/` and will itself migrate into the system store when the feature lands (the last spec authored in-tree).
