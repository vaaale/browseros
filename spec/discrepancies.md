# Spec ↔ Code Discrepancies

This file records places where the **code diverges from the specifications** in
`spec/`. Per the documentation effort, **the code is the source of truth**; these
notes exist so the specs (and a few stale in‑repo references) can be reconciled
later.

Each entry: what the spec says · what the code does · where · suggested action.

Last updated alongside the `docs/usage` + `docs/dev` documentation build.

---

## 1. Documentation layout (single files → trees)

- **Spec:** `spec/bos.md` §Documentation mandates two single files —
  **`docs/USER_GUIDE.md`** (user) and **`docs/DEVELOPMENT.md`** (developer) — and a
  root `CLAUDE.md` that points to them. The in‑OS Docs hub (`data/docs`) surfaces the
  user material.
- **Code/Repo:** documentation is now built as **trees**: `docs/usage/**` (user) and
  `docs/dev/**` (developer). The previous on‑disk files were `docs/user/USER_GUIDE.md`
  and `docs/development/DEVELOPMENT.md` (note: not the exact paths in `bos.md`), now
  **removed** in favour of the trees.
- **Docs app (in‑OS):** the Docs app + `/api/docs` were rewritten to a **read‑only,
  hierarchical viewer** of the project `docs/usage` + `docs/dev` trees (with an
  audience switch), replacing the flat, assistant‑editable `data/docs` hub. The
  `writeDoc` tool was **removed**; the assistant maintains docs by editing the source
  tree (via the developer sub‑agent). `src/lib/docs/store.ts` now reads
  `process.cwd()/docs` (so a previewed candidate shows its own version's docs).
- **Stale references:**
  - `CLAUDE.md` pointed to `docs/DEVELOPMENT.md` / `docs/USER_GUIDE.md` — **updated**
    to point at `docs/dev/architecture-overview.md` and `docs/usage/introduction.md`.
  - `spec/bos.md` §Documentation and `spec/self-modification/self-modification.md`
    §4 still reference `docs/DEVELOPMENT.md`.
- **Action:** update `spec/bos.md` §Documentation to describe the `docs/usage` +
  `docs/dev` trees and that the in‑OS Docs app now renders them **read‑only** (the
  `data/docs` hub and the `writeDoc` tool are retired).

---

## 2. DataFS: no single funnel; stores not migrated

- **Spec:** `spec/self-modification/datafs.md` §1–§2, §6 — **all** runtime‑state
  access MUST go through **one server‑only DataFS module** (`root()`, `readText`,
  `writeAtomic`, `list`, `stat`, `exists`, `mkdir`, `remove`, `rename`); every store
  that joins `process.cwd()/data` MUST be migrated to it; **one write path**
  (`writeAtomic`).
- **Code:** there is **no unified DataFS module**. Stores resolve the root directly
  via `src/os/data-dir.ts` (`dataDir()`) and write with assorted helpers:
  `src/os/atomic-write.ts` `writeFileAtomic` (skills, agents, config, settings)
  or a local temp+rename (`src/lib/agent/memory/curated.ts`). `src/lib/datafs/`
  contains only the **clone** + **probe** (preview isolation), not a read/write
  funnel.
- **Where:** `src/lib/datafs/{clone.ts,probe.ts}`, `src/os/data-dir.ts`,
  `src/os/atomic-write.ts`, every `src/lib/**/store.ts`.
- **Impact:** atomic‑write discipline is *de facto* consistent (hardlink isolation is
  safe), but the "single funnel" abstraction the spec mandates does not exist.
- **Action:** either implement the DataFS funnel or relax the spec to "atomic writes
  + a configurable root via `dataDir()`," which is what the code guarantees.

---

## 3. DataFS: only 3 of 5 clone backends implemented

- **Spec:** `datafs.md` §3 lists **five** backends, all of which "MUST" be
  implemented: (1) ZFS/btrfs **snapshot**, (2) **reflink**, (3) **hardlink farm**,
  (4) **plain copy**, (5) **sparse overlay** (application‑level CoW with whiteouts).
  §4 says overlay + copy are always compatible.
- **Code:** only **reflink**, **hardlink**, and **copy** (plus `auto`) exist.
  `IsolationMethod = "reflink" | "hardlink" | "copy"`. The Supervisor's
  `provisionClone` runs `cp --reflink=auto` / `cp -al` / `cp -a`. **Snapshot
  provisioning** and the **sparse overlay** backend are **not** implemented (the probe
  may detect a CoW dataset, but nothing provisions a snapshot).
- **Where:** `src/lib/datafs/clone.ts`, `src/lib/datafs/probe.ts`,
  `tools/supervisor/supervisor.mjs` (`provisionClone`, `isolationMethod`).
- **Action:** implement snapshot + overlay, or narrow `datafs.md` §3 to the three
  shipped backends and mark snapshot/overlay as future work.

---

## 4. Self-modification: no Playwright "verify" stage; promote gates on `ready`, not `verified`

- **Spec:** `self-modification.md` §4 — a candidate's validation pipeline is
  **typecheck → lint → build → boot → health → E2E (Playwright)**, with states
  `building → ready → testing → verified` (or `failed` / `tests-failed`). §6 — a
  promote **requires a `verified` candidate** (or an explicit override of
  `tests-failed`). `testing.md` specifies the E2E verify stage run by the Supervisor.
- **Code:** the Supervisor implements only `building → ready | failed` (build +
  `/api/health` gate). There is **no `testing`/`verified`/`tests-failed`** stage, no
  Supervisor‑run Playwright pass, and **`promote()` requires `state === "ready"`**.
  The e2e suite exists (`e2e/`, `playwright.config.ts`) but is run **manually / by the
  agent**, not auto‑gated on promote. (`VersionControls.tsx` references test states
  the Supervisor never produces.)
- **Where:** `tools/supervisor/supervisor.mjs` (`buildAndStart`, `promote`),
  `src/components/desktop/VersionControls.tsx`, `e2e/`.
- **Action:** implement the verify stage in the Supervisor, or amend
  `self-modification.md` §4/§6 + `testing.md` to state that promote gates on health
  (`ready`) and E2E is a separate manual/agent step.

---

## 5. Supervisor parameters are env-only (not assistant-exposed config)

- **Spec:** `self-modification.md` treats public port, internal port range, worktree
  setup, base branch, push mode, tag scheme, retain‑previous, and timeouts as
  Supervisor responsibilities; the BOS configuration system is the spec's general
  mechanism for surfacing such settings (Settings tab + assistant tool).
- **Code:** these are **environment variables** read by
  `tools/supervisor/supervisor.mjs` (`BOS_PUBLIC_PORT`, `BOS_PORT_BASE`,
  `BOS_BASE_BRANCH`, `BOS_WORKTREES`, `BOS_PUSH_MODE`, `BOS_REMOTE`,
  `BOS_HEALTH_TIMEOUT_MS`, …). The `self-modification` config namespace exists but its
  `VersionsTab` is **status/actions only** (`fields: []`) — none of these parameters
  are editable in Settings or exposed to the assistant.
- **Action:** if runtime configurability is desired, back the `self-modification`
  namespace with these values; otherwise document them as deploy‑time env only.

---

## 6. Memory: injection scanning is write-time only (no load-time placeholder)

- **Spec:** `spec/memory/memory.md` §8 — memory MUST be scanned for injection/
  exfiltration **at write time AND at snapshot‑build (load) time**; a poisoned
  on‑disk entry MUST be replaced with a **clearly‑marked placeholder in the injected
  snapshot** while remaining visible in the raw store.
- **Code:** scanning happens **only at write time** (`scanThreat` in `applyOps`).
  `memorySnapshot()` reads and renders entries **without re‑scanning** or
  placeholder substitution, so an entry poisoned out‑of‑band (manual edit) would be
  injected verbatim.
- **Where:** `src/lib/agent/memory/curated.ts` (`scanThreat`, `applyOps`,
  `memorySnapshot`).
- **Action:** add a load‑time scan in `memorySnapshot()` that substitutes a
  placeholder for matching entries.

---

## 7. Memory: no external-drift detection

- **Spec:** `memory.md` §8 — if the on‑disk store contains content that wouldn't
  round‑trip through the memory tool (manual edit / concurrent free‑form writer), the
  tool MUST refuse to overwrite, **back up** the file, and ask the operator to
  reconcile.
- **Code:** `curated.ts` serializes writes with an in‑process lock (`withLock`) and
  writes atomically, but performs **no drift detection or backup‑on‑drift**; a
  read‑modify‑write silently re‑serializes whatever it parsed.
- **Action:** implement drift detection/backup, or downgrade §8 to "best‑effort,
  in‑process locking only" (what the code provides).

---

## 8. Memory: `recallMemories` is a live read, not a semantic recall tier

- **Spec:** `memory.md` §3 (optional, "MAY") — a queryable/semantic recall tier
  (`recallMemories`‑style ranked by keyword/semantic match, recency, usefulness),
  complementary to the always‑injected core. §9 — an optional pluggable external
  (e.g. vector) provider.
- **Code:** the `recallMemories` action returns the **live curated entries** (the
  same surfaces, un‑snapshotted) — there is **no ranking/semantic search** and **no
  external provider**.
- **Where:** `src/components/agent/MemoryActions.tsx`, `src/app/api/memory/route.ts`,
  `src/lib/agent/memory/*`.
- **Note:** the spec marks this tier **optional**, so this is a capability gap, not a
  conformance violation. Worth aligning the name/description so `recallMemories` isn't
  mistaken for semantic recall.

---

## 9. Self-improvement: GEPA is a single reflective rewrite (not the full loop)

- **Spec:** `spec/self-improvement/self-improvement.md` (GEPA section) — reflective
  mutation **plus candidate evaluation & scoring against representative tasks**,
  **Pareto/score‑based selection**, **bounded iterative rounds**, and **prior
  versions retained for rollback**.
- **Code:** `improveSkill` performs a **single** reflective rewrite of the skill body
  and records a **self‑reported `score`** in frontmatter. There is no candidate
  generation/evaluation, no Pareto selection, and **no version retention/rollback**.
- **Where:** `src/lib/agent/skills/improve.ts`, `src/app/api/skills/improve/route.ts`.
- **Action:** implement candidate evaluation + version retention, or relabel the spec
  as "GEPA‑lite: single reflective optimization with a self‑reported score."

---

## 10. Self-improvement: Curator is simpler than specified

- **Spec:** `self-improvement.md` §5 — telemetry sidecar with **use count, view
  count, patch count, last‑activity, lifecycle state, pinned**; a **periodic
  scheduler** that **persists scheduler/status state**; **deterministic
  `active → stale → archived`** transitions; an opt‑in **LLM consolidation** pass; a
  **backup snapshot before any destructive pass**.
- **Code:** the sidecar tracks **`useCount`, `patchCount`, `lastActivityAt`** only
  (no view count, no lifecycle‑state field). The Curator archives **directly**
  (`active → archived`, no `stale`), runs **on demand** (no scheduler, no persisted
  state), has **no consolidation pass**, and takes **no pre‑pass backup** (it moves
  skills into a recoverable `.archive/`). Provenance + pinned protections **are**
  honoured (agent‑created only; pinned skipped).
- **Where:** `src/lib/agent/skills/{curator.ts,usage.ts}`,
  `src/app/api/skills/curator/route.ts`.
- **Action:** add the missing lifecycle/telemetry/scheduler/consolidation pieces, or
  reduce §5 to the shipped behaviour.

---

## 11. Self-improvement & memory configuration not exposed

- **Spec:** `self-improvement.md` §10 and `memory.md` §11 — a config namespace MUST
  expose at least: **memory size budgets**; whether the **review** runs and which
  **model** it uses; **GEPA triggers**; **Curator settings** (interval, staleness/
  archive thresholds, prune‑bundled); the **write‑approval gate**; the **active memory
  provider**; and the **proactive‑suggestions** toggle.
- **Code:** none of these are configuration values. Memory budgets are **hardcoded**
  (`LIMITS = { user: 1200, memory: 2000 }`); the review/curator/improve run via fixed
  routes with no on/off, model, threshold, or gate settings; there is no `skills`/
  memory config namespace beyond the **editor** (`SkillsTab`) and the Memory app.
- **Where:** `src/lib/agent/memory/curated.ts` (`LIMITS`), `src/lib/config/registry.ts`
  (no such namespace), `src/lib/agent/skills/*`, `src/lib/agent/review.ts`.
- **Action:** add a `self-improvement` (and/or `memory`) config namespace, or trim the
  spec's configuration requirements.

---

## 12. Proactive "suggestions" surface not implemented

- **Spec:** `self-improvement.md` §10 — the assistant surfaces **suggestions** for the
  user to **accept or dismiss**, plus a proactive‑suggestions toggle.
- **Code:** no proactive‑suggestions feature was found — learning happens via the
  post‑task review (`reflectAndLearn`) and explicit `improveSkill`/`runCurator`
  actions; there is no suggestion inbox/accept‑dismiss UI.
- **Action:** implement or drop from the spec.

---

## 13. `bos.md` says "no dedicated build tool", but `buildApp` exists

- **Spec:** `spec/bos.md` §Apps (§138, §157) states there is **"no dedicated build
  tool"** — app creation goes through the Developer sub‑agent plus `installApp`.
  However `spec/self-modification/apps.md` **does** specify project apps that are
  bundled at install time.
- **Code:** a dedicated **`buildApp`** action + **`/api/apps/build`** route +
  **`src/lib/apps/build.ts`** (esbuild) implement project‑app bundling, matching
  `apps.md` (not `bos.md`).
- **Where:** `src/components/agent/DevActions.tsx`, `src/app/api/apps/build/route.ts`,
  `src/lib/apps/build.ts`.
- **Action:** update `bos.md` §Apps to acknowledge `buildApp`/project apps (align it
  with `apps.md` and the code). It remains true that there is **no separate "Dev
  Studio" app**.

---

## 14. Memory pluggable providers (forward-looking) — not implemented

- **Spec:** `memory.md` §9 — BOS SHOULD treat memory as a pluggable capability and
  MAY support one external provider at a time (lifecycle: init / system‑prompt block /
  `prefetch` / `sync_turn` / tool schemas / shutdown).
- **Code:** only the built‑in file‑backed curated core exists; there is no provider
  abstraction or selection.
- **Note:** the spec marks external providers **optional / forward‑looking**, so this
  is a known gap, not a violation. Listed for completeness.

---

## Conformant highlights (spec met — for reference)

To avoid re‑investigation, these spec points **are** implemented as written:

- Memory: two curated surfaces, character budgets with **reject‑on‑overflow**, atomic
  batch ops, substring `replace`/`remove` with **refuse‑on‑ambiguity**, in‑process
  write locking, frozen‑snapshot injection (`curated.ts`).
- Memory: **leaf sub‑agents cannot write memory** — the memory tool is not in
  `SUBAGENT_TOOLS`; only the parent assistant + the restricted review pass write
  (`memory.md` §8).
- Self‑modification: separate stable Supervisor owning the public port; per‑session
  preview pin; retain‑previous + rollback; `/__supervisor` fallback page with
  rollback + push; code‑only promote discarding the data clone.
- DataFS: base‑read‑only‑during‑preview invariant; copy is the universal floor;
  `datafs` config namespace + first‑run wizard step.
- Config system: a namespace yields **both** a Settings tab and assistant tools.
- Dev harness: headless Claude CLI default + MCP (stdio/HTTP/SSE); development is
  Claude‑only with a permission gate for non‑dev Claude use.
