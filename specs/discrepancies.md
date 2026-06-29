# Spec ↔ Code Discrepancies

This file records places where the **code diverges from the specifications** in `specs/`.
Per the documentation effort, **the code is the source of truth**; these notes exist so the
specs can be reconciled later.

Each entry: what the spec says · what the code does · where · suggested action.

> Migrated from `spec/discrepancies.md` during the spec-kit migration (Phase 2). References
> now point at the new `specs/<NNN-feature>/spec.md` locations. Entries that were caused by
> the *old* specs being stale (documentation layout, "no build tool") are now **RESOLVED**,
> because the migrated specs describe the as-built behavior.

---

## 1. Documentation layout (single files → trees) — RESOLVED

- **Old spec:** `spec/bos.md` mandated two single files (`docs/USER_GUIDE.md`, `docs/DEVELOPMENT.md`).
- **Code/Repo:** documentation is built as trees: `docs/usage/**` and `docs/dev/**`; the in-OS Docs app is a read-only hierarchical viewer of those trees (the `writeDoc` tool was removed; `src/lib/docs/store.ts` reads `process.cwd()/docs`).
- **Resolution:** the migrated `specs/010-documentation/spec.md` now specifies the `docs/usage` + `docs/dev` trees and the read-only Docs app, matching the code. No further action.

---

## 2. DataFS: no single funnel; stores not migrated

- **Spec:** `specs/006-data-isolation/spec.md` FR-001/FR-003 — all runtime-state access MUST go through one server-only DataFS module; one write path (`writeAtomic`).
- **Code:** there is **no unified DataFS module**. Stores resolve the root directly via `src/os/data-dir.ts` (`dataDir()`) and write with assorted helpers: `src/os/atomic-write.ts` `writeFileAtomic` (skills, agents, config, settings) or a local temp+rename (`src/lib/agent/memory/curated.ts`). `src/lib/datafs/` contains only the **clone** + **probe** (preview isolation), not a read/write funnel.
- **Where:** `src/lib/datafs/{clone.ts,probe.ts}`, `src/os/data-dir.ts`, `src/os/atomic-write.ts`, every `src/lib/**/store.ts`.
- **Action:** either implement the DataFS funnel or relax the spec to "atomic writes + a configurable root via `dataDir()`," which is what the code guarantees.

---

## 3. DataFS: only 3 of 5 clone backends implemented

- **Spec:** `specs/006-data-isolation/spec.md` FR-004 lists five backends, all "MUST": ZFS/btrfs snapshot, reflink, hardlink farm, plain copy, sparse overlay.
- **Code:** only **reflink**, **hardlink**, and **copy** (plus `auto`) exist. `IsolationMethod = "reflink" | "hardlink" | "copy"`. The Supervisor's `provisionClone` runs `cp --reflink=auto` / `cp -al` / `cp -a`. **Snapshot** provisioning and the **sparse overlay** backend are **not** implemented.
- **Where:** `src/lib/datafs/clone.ts`, `src/lib/datafs/probe.ts`, `tools/supervisor/supervisor.mjs` (`provisionClone`, `isolationMethod`).
- **Action:** implement snapshot + overlay, or narrow FR-004 to the three shipped backends and mark snapshot/overlay as future work.

---

## 4. Self-modification: no Playwright "verify" stage; promote gates on `ready`, not `verified`

- **Spec:** `specs/008-self-testing/spec.md` specifies a verify stage after health (`ready → testing (Playwright) → verified | tests-failed`) and a `gatePolicy`. (`specs/005-self-modification/spec.md` FR-004 was **revised to match the code** — `idle → building → ready | failed` — so the gap is now only with `008`.)
- **Code:** the Supervisor implements only `idle → building → ready | failed` (build + `/api/health`). There is **no `testing`/`verified`/`tests-failed`** stage and **`promote()` requires `state === "ready"`**. The e2e suite exists (`e2e/`, `playwright.config.ts`) but is run manually / by the agent. `VersionControls.tsx` tracks only `ready`/`building`/`failed`/`stopped` (no test states).
- **Where:** `tools/supervisor/supervisor.mjs` (`buildAndStart`, `promote`), `src/components/desktop/VersionControls.tsx`, `e2e/`.
- **Action:** implement the verify stage in the Supervisor, or keep `008` as a deferred companion (`005` already states promote gates on health = `ready`, with E2E a separate manual/agent step).

---

## 5. Supervisor parameters are env-only (not assistant-exposed config)

- **Spec:** `specs/005-self-modification/spec.md` FR-011 surfaces public/base ports, preview pool size, worktrees location, base branch, push mode + remote, tag scheme, and build/health timeouts via the configuration system (Settings tab + assistant tool).
- **Code:** these are **environment variables** read by `tools/supervisor/supervisor.mjs` (`BOS_PUBLIC_PORT`, `BOS_PORT_BASE`, `BOS_PORT_POOL_SIZE`, `BOS_BASE_BRANCH`, `BOS_WORKTREES`, `BOS_PUSH_MODE`, `BOS_REMOTE`, `BOS_HEALTH_TIMEOUT_MS`, …). The `self-modification` namespace's `VersionsTab` is status/actions only (`fields: []`).
- **Action:** back the `self-modification` namespace with these values, or document them as deploy-time env only.

---

## 6. Memory: injection scanning is write-time only (no load-time placeholder)

- **Spec:** `specs/002-memory/spec.md` FR-008 — scan at write time AND at snapshot-build (load) time; a poisoned entry MUST be placeholdered in the injected snapshot while remaining in the raw store.
- **Code:** scanning happens **only at write time** (`scanThreat` in `applyOps`). `memorySnapshot()` renders entries without re-scanning, so an out-of-band poisoned entry would be injected verbatim.
- **Where:** `src/lib/agent/memory/curated.ts` (`scanThreat`, `applyOps`, `memorySnapshot`).
- **Action:** add a load-time scan in `memorySnapshot()` that substitutes a placeholder for matching entries.

---

## 7. Memory: no external-drift detection

- **Spec:** `specs/002-memory/spec.md` FR-009 — if the on-disk store wouldn't round-trip through the memory tool, refuse to overwrite, back up the file, and ask the operator to reconcile.
- **Code:** `curated.ts` serializes writes with an in-process lock and writes atomically, but performs **no drift detection or backup-on-drift**.
- **Action:** implement drift detection/backup, or downgrade FR-009 to "best-effort, in-process locking only."

---

## 8. Memory: `recallMemories` is a live read, not a semantic recall tier

- **Spec:** `specs/002-memory/spec.md` FR-011 (optional) — a queryable/semantic recall tier ranked by match/recency/usefulness, plus an optional external provider.
- **Code:** `recallMemories` returns the **live curated entries** — no ranking/semantic search, no external provider.
- **Where:** `src/components/agent/MemoryActions.tsx`, `src/app/api/memory/route.ts`, `src/lib/agent/memory/*`.
- **Note:** the spec marks this tier optional, so this is a capability gap, not a violation. Align the name/description so `recallMemories` isn't mistaken for semantic recall.

---

## 9. Self-improvement: GEPA is a single reflective rewrite (not the full loop)

- **Spec:** `specs/003-self-improvement/spec.md` FR-006 — reflective mutation plus candidate evaluation & scoring, Pareto/score-based selection, bounded rounds, and prior versions retained for rollback.
- **Code:** `improveSkill` performs a **single** reflective rewrite and records a self-reported `score`. No candidate generation/evaluation, no Pareto selection, no version retention/rollback.
- **Where:** `src/lib/agent/skills/improve.ts`, `src/app/api/skills/improve/route.ts`.
- **Action:** implement candidate evaluation + version retention, or relabel as "GEPA-lite."

---

## 10. Self-improvement: Curator is simpler than specified

- **Spec:** `specs/003-self-improvement/spec.md` FR-007 — telemetry sidecar (use/view/patch counts, last-activity, lifecycle state, pinned); a periodic scheduler that persists state; deterministic `active → stale → archived`; opt-in LLM consolidation; backup before any destructive pass.
- **Code:** the sidecar tracks `useCount`, `patchCount`, `lastActivityAt` only. The Curator archives directly (`active → archived`, no `stale`), runs on demand (no scheduler/persisted state), has no consolidation pass, and takes no pre-pass backup (it moves skills into a recoverable `.archive/`). Provenance + pinned protections **are** honored.
- **Where:** `src/lib/agent/skills/{curator.ts,usage.ts}`, `src/app/api/skills/curator/route.ts`.
- **Action:** add the missing lifecycle/telemetry/scheduler/consolidation pieces, or reduce FR-007 to the shipped behavior.

---

## 11. Self-improvement & memory configuration not exposed

- **Spec:** `specs/003-self-improvement/spec.md` FR-011 and `specs/002-memory/spec.md` FR-012 — a config namespace MUST expose memory budgets, review on/off + model, GEPA triggers, Curator settings, the write-approval gate, the active provider, and the proactive-suggestions toggle.
- **Code:** none of these are configuration values. Memory budgets are hardcoded (`LIMITS = { user: 1200, memory: 2000 }`); review/curator/improve run via fixed routes with no settings; there is no `skills`/memory config namespace beyond the editor (`SkillsTab`) and the Memory app.
- **Where:** `src/lib/agent/memory/curated.ts` (`LIMITS`), `src/lib/config/registry.ts`, `src/lib/agent/skills/*`, `src/lib/agent/review.ts`.
- **Action:** add a `self-improvement` (and/or `memory`) config namespace, or trim the configuration requirements.

---

## 12. Proactive "suggestions" surface not implemented

- **Spec:** `specs/003-self-improvement/spec.md` FR-009 — the assistant surfaces suggestions for the user to accept/dismiss, plus a proactive-suggestions toggle.
- **Code:** no proactive-suggestions feature — learning happens via the post-task review (`reflectAndLearn`) and explicit `improveSkill`/`runCurator` actions; there is no suggestion inbox/accept-dismiss UI.
- **Action:** implement or drop from the spec.

---

## 13. "No dedicated build tool" vs `buildApp` — RESOLVED

- **Old spec:** `spec/bos.md` stated there was "no dedicated build tool" while `spec/self-modification/apps.md` specified project apps bundled at install.
- **Code:** a dedicated `buildApp` action + `/api/apps/build` route + `src/lib/apps/build.ts` (esbuild) implement project-app bundling.
- **Resolution:** the migrated `specs/009-installed-apps/spec.md` (FR-003/FR-005) specifies `buildAppDir`/`buildApp` and project apps, matching the code; `specs/000-browseros-core` keeps "no separate Dev Studio app." No further action.

---

## 14. Memory pluggable providers (forward-looking) — not implemented

- **Spec:** `specs/002-memory/spec.md` FR-011 — BOS SHOULD treat memory as pluggable and MAY support one external provider at a time.
- **Code:** only the built-in file-backed curated core exists; no provider abstraction.
- **Note:** the spec marks external providers optional / forward-looking, so this is a known gap, not a violation.

---

## Conformant highlights (spec met — for reference)

- Memory: two curated surfaces, character budgets with reject-on-overflow, atomic batch ops, substring `replace`/`remove` with refuse-on-ambiguity, in-process write locking, frozen-snapshot injection (`curated.ts`).
- Memory: leaf sub-agents cannot write memory — the memory tool is not in `SUBAGENT_TOOLS`; only the parent assistant + the restricted review pass write.
- Self-modification: separate stable Supervisor owning the public port; one always-on **base** + at most one **preview** on a pooled port (branch-named worktrees); per-session preview pin; safe-ordering promote (build + health-gate on the base port before moving the base ref); one-conversation-↔-one-feature-branch continuity across a Stop; `/__supervisor` fallback page (Preview / Back to base / Promote / Stop / Push); code-only promote discarding the data clone. (Rollback is deferred — every promote leaves a `bos/v<timestamp>` tag as the anchor.)
- DataFS: base-read-only-during-preview invariant; copy is the universal floor; `datafs` config namespace + first-run wizard step.
- Config system: a namespace yields **both** a Settings tab and assistant tools.
- Dev harness: headless Claude CLI default + MCP (stdio/HTTP/SSE); development is Claude-only with a permission gate for non-dev Claude use.
- Build Studio: spec-scoped tools jailed to `specs/` + `.specify/`; a local agent that delegates implementation to the Developer (`specs/001-build-studio`).
