# BrowserOS Self-Modification (Live Version Control) — Specification

BOS can modify its own source (the Next.js app under `src/`). The hazard this document addresses is **applying a change to the very code paths that are executing the change**: when the developer sub-agent edits the chat route, the sub-agent runner, the dev harness, or any module the running server depends on, a hot-reload or restart of that module can break the live instance mid-flight — including the conversation that requested the change.

This spec defines **live version control**: BOS MUST be able to run **multiple versions of itself concurrently** so that a self-modification never takes down the running instance, and so that a candidate version can be **previewed, promoted, rolled back, or discarded** safely. It expands the `spec/bos.md` requirements "BOS Self improvement" and "Minimizing blast radius".

It pairs with two other specs:
- `spec/self-modification/datafs.md` — the **data-isolation layer** that lets concurrent versions share one canonical data store while a previewed candidate writes to an isolated, throwaway copy. This document is authoritative for the control plane; `datafs.md` is authoritative for the data plane.
- `spec/self-improvement/self-improvement.md` §8 — the **BOS-codebase self-improvement** activity (the developer sub-agent deciding *what* source change to make). That spec decides what to change; **this** spec makes applying the change safe at runtime.

---

## 1. Principles

- **The swap mechanism MUST live outside the swappable unit.** The component that builds, validates, and promotes a new version of BOS MUST NOT be part of the BOS instance being replaced. Otherwise a self-modification can break the very code performing the swap (the chicken-and-egg failure). This mandates a separate, stable **Supervisor** (§2).
- **The running version is immutable while a candidate is built.** Self-modifications land in an isolated copy of the source, never in the tree the live instance is serving from.
- **Every transition is reversible.** A promote has a rollback; a candidate can be discarded; the prior version is retained. This is the runtime expression of the `spec/bos.md` "minimize blast radius" rule.
- **Portability.** The feature MUST work anywhere BOS runs, including unprivileged Docker. No part of the *core* path may hard-depend on a specific filesystem, kernel feature, or elevated privilege (see `spec/self-modification/datafs.md` for how the data plane degrades gracefully).
- **The user stays in control.** A candidate is promoted only by an explicit user action, after the user has had the opportunity to test it.

---

## 2. Two planes: Supervisor and BOS versions

BOS self-modification splits the system into a stable control plane and a swappable data/app plane.

```
                  ┌─────────────────────────────────────────────┐
   browser ─────► │  SUPERVISOR  (control plane — stable)         │  public port
                  │  reverse proxy + version registry + lifecycle │
                  │  build · health · preview · promote · rollback│
                  └───────────────┬─────────────────────────────┘
                       routes to the session's pinned version
            ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
            │ BOS "previous"   │   │ BOS "active"     │   │ BOS "next"        │
            │ worktree :310x   │   │ worktree :310y   │   │ worktree :310z    │
            │ own .next        │   │ own .next        │   │ own .next         │
            │ BOS_DATA_DIR     │   │ BOS_DATA_DIR=base│   │ BOS_DATA_DIR=clone│
            └──────────────────┘   └────────┬─────────┘   └──────────────────┘
                                            └── canonical shared data (base) ──┘
```

### 2.1 Supervisor (control plane)
A small, long-lived process that owns the public port. It MUST be:
- **Stable and minimal** — it changes rarely and has no application logic beyond version management and proxying.
- **Off-limits to self-modification** — the developer sub-agent MUST NOT edit the Supervisor. Updating the Supervisor is a deliberate, manual operational step (a restart), analogous to updating a bootloader/kernel. Allowing BOS to rewrite its own Supervisor would reintroduce the chicken-and-egg the Supervisor exists to prevent.

Responsibilities: process lifecycle of BOS versions; git worktree lifecycle (§3); build + health validation (§4); reverse-proxy routing and per-session preview (§5); promote / rollback / discard / drain (§6); and driving the data-isolation lifecycle (§8, `spec/self-modification/datafs.md`).

### 2.2 BOS versions (data/app plane)
Each version is an ordinary BOS (Next.js) instance, launched by the Supervisor from a git worktree, on its own internal port, with its own `.next` build output, and its own data root (`BOS_DATA_DIR`). These instances are the units that get created, previewed, promoted, and reaped. They contain all the application logic and are the only things the developer sub-agent ever edits.

---

## 3. The unit of versioning — git worktrees

- A **version is a git worktree** sharing the repository's single `.git`. Worktrees give cheap, isolated checkouts without cloning.
- Named roles:
  - **active** — the promoted version that the Supervisor routes all traffic to by default.
  - **next** — the candidate the developer sub-agent edits and the user previews.
  - **previous** — the prior `active`, retained after a promote so a rollback is instant.
- **Hard-coded worktree setup (MUST be deterministic, not agent-driven).** At the start of any self-modification task, the Supervisor MUST:
  1. Ensure the `next` worktree exists and **reset it to `active`'s current commit** (a clean branch off the running version).
  2. Provision an isolated data clone for `next` (see `spec/self-modification/datafs.md`).
  3. Point the developer harness's working directory at the `next` worktree.
  The developer sub-agent therefore edits **only** `next`; it is structurally incapable of editing the running tree, even by mistake. This setup MUST NOT be delegated to the LLM — it is a fixed routine the Supervisor performs.
- **Integration with the existing Dev Harness.** The harness already accepts a configurable working directory (Settings → Dev Harness, per `spec/bos.md`). Self-modification runs MUST set that working directory to the `next` worktree path.

---

## 4. Build and health gate

- A candidate MUST be built as an **immutable production build** in its own worktree (`next build` into that worktree's own `.next`), then run (`next start` on its own internal port). Production builds — not a shared `next dev` hot-reload — are the version unit: they are immutable snapshots, and a per-worktree `.next` avoids the shared-`.next` hazard documented in `docs/DEVELOPMENT.md`.
- Before a candidate may be previewed or promoted, it MUST pass a validation pipeline: **typecheck → lint → build → boot → health probe**. The health probe is an HTTP `GET /api/health` against the candidate's own port.
- A candidate carries a state: `building → ready` on success, `building → failed` on any pipeline failure (with logs retained for inspection). Only a `ready` candidate is previewable/promotable.
- BOS MUST expose a cheap **`/api/health`** endpoint reporting readiness (process up, data root readable, app able to render). The Supervisor uses it for the gate and for liveness of running versions.

---

## 5. Routing, preview, and the control surface

### 5.1 Default routing
The Supervisor reverse-proxies the public port. By default it routes **all** traffic to `active`. The real `active` pointer changes only on a promote/rollback (§6) — never as a side effect of previewing.

### 5.2 Per-session preview pin
The user MUST be able to **temporarily switch their own session to another version**, test it, and switch back, without moving the global `active` pointer and without affecting other sessions or background work.
- A control issues `POST /__supervisor/pin {version}` (e.g. `next`, `previous`, `active`/clear). The Supervisor sets a **session cookie** (e.g. `bos_pin`) and routes that session's requests to the named version. The public URL is unchanged throughout, so the previewed version is exercised end-to-end (its UI, its server routes, its behavior).
- Clearing the pin returns the session to `active`.
- Preview is **gated on health**: a version is pinnable only when `ready`, so a control never pins a session to a failing build.
- A previewed candidate reads/writes an **isolated data clone**, so manual testing cannot pollute production data (§8, `spec/self-modification/datafs.md`).

### 5.3 Supervisor control page (un-brickable fallback)
The Supervisor MUST serve a minimal, **version-independent** control page at `/__supervisor` (plain HTML rendered by the Supervisor itself, not by any BOS version). It MUST remain reachable even if a BOS version's UI is broken, and MUST offer at least: show current version state; pin/clear a preview; rollback. This is the guaranteed escape hatch if a candidate (or even the active version) renders a broken UI.

### 5.4 In-OS controls (Topbar)
For ergonomics, BOS's Topbar MUST surface the version controls: the current version and the candidate's state (`building`/`ready`/`failed`), and the actions **Preview next**, **Back to active**, **Promote**, and **Discard**. These call the Supervisor control API (same origin). The Topbar is the convenient path; the Supervisor control page (§5.3) is the guaranteed one. Because the Topbar lives inside the swappable unit, the system MUST NOT depend on it alone for switching away from a broken version.

---

## 6. Promote, rollback, discard, drain

- **Promote (code-only).** Make `next` the new `active`; the prior `active` becomes `previous`; flip the default upstream. Promote is **code-only**: there is **no data merge** — the candidate's data clone is discarded and the canonical shared data carries forward unchanged (see §8 and `spec/self-modification/datafs.md`; promote-and-merge is explicitly out of scope).
- **Rollback.** Flip the default upstream back to `previous`. Because `previous` is still running (or can be re-launched from its worktree), rollback is fast.
- **Discard candidate.** Stop the `next` process, reset/remove its worktree, and delete its data clone. The system returns to a single `active` version.
- **Drain.** On any flip, the version losing traffic MUST be kept alive until its in-flight requests finish — notably the streaming chat response that may have triggered the self-modification — and only then reaped. New navigations and requests go to the new `active`.
- **Continuity across a flip.** Because data is canonical/shared (base), chats, memory, and skills written before the flip are visible to the new `active`. The conversation that requested the change completes on the old version (drain); the user's next message lands on the new one.

---

## 7. The self-modification lifecycle

```
                ┌─────────── rollback ──────────┐
                ▼                                │
 idle ─ begin ─► [next @ active HEAD + data clone] ─► agent edits next ─► validate
   ▲              (deterministic, Supervisor)                              (tsc·lint·
   │                                                                        build·health)
   │                                                                          │
   │                                                          failed ◄────────┤
   │                                                                          ▼ ready
   │                                                       ┌──── preview (per-session) ◄─┐
   │                                                       │            │                │
   └──────────── discard (drop next + clone) ◄─────────────┘            │  switch back ──┘
                                                                        ▼
                                                       promote (flip · drain · discard clone)
```

- **begin**: a self-modification task starts → Supervisor provisions `next` (§3) and its data clone (§8).
- **edit**: the developer sub-agent edits `next` only.
- **validate**: the build/health gate (§4) moves `next` to `ready` or `failed`.
- **preview**: the user pins their session to `next` (§5.2), tests, and switches back at will.
- **promote / discard / rollback**: per §6.

---

## 8. Data isolation

Each running version operates against a data root per `spec/self-modification/datafs.md`:
- `active` uses the **canonical base** data directly (zero overhead — no clone while nothing is being previewed).
- A previewed candidate uses an **isolated copy-on-write clone** of base, so manual testing never mutates production state. The base is read-only for the duration of a preview.
- Because promote is **code-only** (§6), the clone is always discarded on promote or discard; base is the single source of truth and carries forward.

The mechanism for producing the clone is pluggable and chosen by a capability probe with a BOS-level setting; see `spec/self-modification/datafs.md`.

---

## 9. Constraints & guarantees

- **Supervisor immutability.** The developer sub-agent MUST NOT modify the Supervisor; Supervisor changes require a deliberate manual restart. Rationale: it is the trusted kernel that breaks the chicken-and-egg.
- **Data-schema compatibility across versions.** Because base data is shared/canonical and a rollback returns to the prior code, **a version that changes the on-disk schema of `data/` MUST keep it backward-compatible** (the prior code must still read it) — otherwise a rollback breaks. On-disk schema changes are the one thing this model does not isolate; they MUST be designed for forward/backward compatibility.
- **Background work runs on `active`.** Automated/background jobs (workflows, scheduled tasks, the self-improvement review and Curator from `spec/self-improvement/self-improvement.md`) run on `active`, never on a preview. Preview is strictly interactive/foreground.
- **Single-user preview assumption.** Preview pinning is per-session and intended for the operator testing a candidate.
- **Sandboxed execution.** The developer harness runs non-interactively (`--dangerously-skip-permissions`, per `spec/bos.md`); combined with worktree isolation, candidates are edited and built without ever touching `active`. This is intended to run sandboxed (e.g. Docker).

---

## 10. UI & configuration

- **Topbar** version controls (§5.4) and the **Supervisor control page** (§5.3).
- A **Versions** view (a Settings tab and/or the control page) listing the versions (`active`/`next`/`previous`), their state, build logs, and history, with one-click promote / rollback / discard.
- A **configuration namespace** (e.g. `self-modification`) MUST expose at least: the public port, the internal port range, the worktrees location, the retain-`previous` policy, and the build/health timeouts. Per the BOS configuration system this also exposes these to the assistant as tools.
- **First-run.** The first-startup wizard already configures the AI provider and Dev Harness (`spec/bos.md`); the data-isolation method it must also configure is specified in `spec/self-modification/datafs.md`.

---

## 11. Relationship to other specs

- **`spec/self-modification/datafs.md`** — the data-isolation layer (copy-on-write clone backends, capability probe, the isolation-method setting) this feature relies on for safe preview and code-only promote.
- **`spec/self-improvement/self-improvement.md` §8** — the BOS-codebase self-improvement activity (the developer sub-agent editing source) that produces the changes this spec makes safe to apply at runtime.
- **`spec/bos.md`** — the Developer sub-agent and Dev Harness, the feature-branch / minimize-blast-radius rule, the configuration system, and the first-startup wizard.
