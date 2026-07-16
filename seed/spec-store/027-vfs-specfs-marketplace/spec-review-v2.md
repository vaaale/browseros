# Review v2: 027 — VFS Mount Points, SpecFS, Feature Context, Provider Registry, Marketplace

**Reviewer**: Claude (design review, second pass) · **Date**: 2026-07-15 · **Artifacts**: revised `spec.md`, `plan.md`, `tasks.md` · **Predecessor**: `spec-review.md`
**Verdict**: The revision resolves **all ten** findings from v1, and the resolutions are code-accurate (verified against source, below). The design is now internally consistent and implementable. Remaining issues are **narrower**: one genuine gap in the adopted branch model, one concrete seed-behaviour gap, a couple of overclaims to tighten, and a strategic concern that the scope roughly doubled and now gates the P1 relocation behind a 7-phase mega-feature.

---

## Verification of the revision's load-bearing claims

I re-read the source the new artifacts lean on. Every new claim holds:

| Claim in revised plan/spec | Source | Result |
|---|---|---|
| Broker authenticates by `e.source === iframe.contentWindow` (`IframeApp.tsx:83`) — correct for opaque frames | `src/components/apps/IframeApp.tsx:83` | ✅ exact match; `dispatch()` runs parent-side (l.103) so brokered `fetch` survives loss of `allow-same-origin` |
| Current iframe path is same-origin | `IframeApp.tsx:118` (`sandbox="… allow-same-origin"`) | ✅ confirmed — removing it to get an opaque origin is sound |
| SDK is a hard-coded string with a private `call()` transport | `src/app/__bos/sdk.js/route.ts:7-50` | ✅ confirmed; promoting to a TS lib + `storage` namespace is coherent |
| esbuild already a dep (no `package.json` change) | `src/lib/apps/build.ts:2` (`import * as esbuild`) | ✅ present; SDK build step reuses it |
| SpecFS adopts the 020 worktree engine; `readFileAtBranch`/`commitOnSave` reused | `src/lib/specs/store-git.ts:43,86` | ✅ both exist and behave as described (ref-pinned `git show <branch>:path`) |
| Supervisor drives the worktree/`BOS_SPECS_ROOT` model that must be repointed | `tools/supervisor/supervisor.mjs:308-394,446,638` | ✅ confirmed — repoint (not rewrite) is the right call |

## Resolution of v1 findings

**Blockers — all resolved.**
1. **SpecFS↔Supervisor collision** → resolved by *adopting* 020 rather than replacing it: no `git checkout`, ref-pinned reads, worktree writes, explicit Supervisor repoint (spec §"Branch model"; plan P3.7). Matches the real code.
2. **System-spec authoring dropped** → resolved with an explicit decision (Option B): system specs read-only at runtime, edited as source via the Developer agent (spec §Ownership split, US5). Closeout cross-spec merges become source edits.
3. **Two-writer context race + ordering race** → resolved with a server-authoritative single-writer module (mutex + atomic RMW), client issues awaited intents, SpecFS mutates in-process via the same module (plan P1.6/P1.9/P2.5; test P1.7).
4. **Iframe serving path for local/marketplace apps** → resolved (plan P6.6 extends `[...slug]`). Verified this was genuinely missing (route serves only `appsDir()`).

**Should-fix — all resolved.**
5. Ref-pinned reads (P2.2), force-flush before promote (P2.7/P2.11), first-class conflict result (US3.3).
6. Developer agent via Supervisor, never raw checkout of the running tree (Phase 7).
7. Marketplace trust model — opaque-origin sandbox + URL allowlist + schema validation + `execFile` (P5.2/P5.4/P6.1). Strong resolution.
8. First-class `[T]` test tasks (P1.4, P1.7, P2.14, P5.4, P5.7, P6.8).

**Nice-to-have — all resolved.**
9. Tasks renumbered `P<phase>.<n>` to match the plan; promotion moved into Phase 2 (its P1 home); heavy tasks split.
10. `id` sanitization `^[a-z0-9-]+$` (P1.6), bounded LLM diff (P2.4), full `specsRoot`/`BOS_SPECS_ROOT` consumer enumeration incl. `pipeline.ts`, `skills/store.ts`, `supervisor.mjs` (P3.6).

The `storage`-capability + SDK-shim answer to "opaque origins have no storage" is a genuinely good addition — it turns a sandboxing constraint into per-app isolation *with* persistence.

---

## New / residual findings

### N1 — (Real gap) Two worktrees on one branch when a spec-only feature becomes source-inclusive
The branch model routes writes to "the Supervisor worktree when a preview exists; else self-provision `data/specs/user-worktrees/<branch>/`" (spec §Branch model; plan P2.3). It does not cover the **transition**: a feature that starts spec-only gets a SpecFS-self-provisioned worktree on `bos/feat/<id>`; if the Developer agent later touches source, the Supervisor tries to add *its own* worktree on the same branch — and `git worktree add` refuses a branch already checked out elsewhere (`fatal: '<branch>' is already checked out at …`). Specify the hand-off: when a Supervisor preview spins up for an already-active spec-only feature, SpecFS must prune its self-provisioned worktree and defer to the Supervisor's (or always prefer the Supervisor worktree and lazily migrate). This is the one place the adopted model still has a sharp edge.

### N2 — (Concrete gap) System-spec seed sync must become mirror, not additive, under Option B
`seed.ts` today syncs the system store **additively** (`copyMissing`, `src/lib/specs/seed.ts:46-59`) — deliberately never clobbering local edits, because the old model treated the system store as writable. Option B makes system specs **read-only** at runtime, so there are no local edits to protect — but an additive sync now means a system spec *modified* in a new BOS release won't propagate to an existing user's `data/specs/system/` (the file already exists, so `copyMissing` skips it). The plan says "re-seed system specs into `data/specs/system/`" (P2.9) but doesn't change the sync semantics. Decision needed: the read-only system store should be **mirrored** from `seed/spec-store/` on each boot (overwrite/prune), not merged. Otherwise system-spec edits ship but never reach existing users.

### N3 — (Overclaim) "Unmodified open-web apps still work" is too strong for a sync-storage-over-async shim
The `localStorage`/`sessionStorage` shim (plan P6.5) hydrates the namespace into an in-memory `Map` at load and offers a ready-promise. But `localStorage` is **synchronous and available at first script execution**, and the hydrate is an async `postMessage` round-trip. Any open-web app that reads storage during its initial synchronous module evaluation (very common) sees a **cold cache** on first paint. Likewise, removing `allow-same-origin` breaks the frame's own **relative `fetch('/api/…')`** (now against a `null` origin), which the SDK does *not* shim — only storage is brokered. So the accurate claim is narrower: *storage-using* apps that read after `bos:ready` work; apps that touch storage synchronously at startup, or that make same-origin network calls, still need adaptation. Tighten spec lines 59 and US6.3 to state the limitation (or add a sync-hydrate strategy and say so). Flag under the standing no-silent-failures posture: a cold-cache read that silently returns `null` is exactly the kind of quiet-wrong behaviour to call out.

### N4 — (Strategic) Scope roughly doubled; the P1 relocation is now gated behind a 7-phase mega-feature
The branch is `bos/relocate-user-specs`; the motivating P1 problem is US1–US4 (relocate user-specs, any-app writes, wipe-safety, instant promote) — deliverable by **Phases 1–3**. The revision additionally absorbed: opaque-origin sandboxing, promoting the SDK to a bundled TS library, a full `storage` capability + shim, and a Supervisor repoint. Phase 6 in particular bundles four unrelated concerns (sandbox model, SDK library/build, storage shim, *and* Docker/bastion env cleanup — P6.7 has nothing to do with sandboxing). Consider: land Phases 1–3 (+ the Supervisor repoint) as the shippable relocation, and split the sandbox/SDK/storage/marketplace work into a follow-on feature (e.g. `028-marketplace-sandbox`). This shrinks blast radius, gets the actual requested change out sooner, and lets the sandbox design (N3) bake independently. Minimally: unbundle P6.7 (bastion) from Phase 6.

### N5 — (Residual test gap) No test/verification for the Supervisor repoint or the LVC preview→promote path
P3.7 repoints the highest-risk, hardest-to-test component (the `.mjs` Supervisor that owns LVC previews and branch-coupled promote). None of the `[T]` tasks exercise it. Given LVC's known fragility, add at least a manual/e2e checklist item: start a preview on a feature branch, write a spec through the VFS, confirm it appears in the preview worktree, promote, confirm main fast-forwards and the worktree is pruned. Without this, a repoint regression won't surface until runtime.

### N6 — (Minor) Worktree path naming for slashed branch names
`data/specs/user-worktrees/<branch>/` with `branch = bos/feat/<id>` yields nested dirs (`user-worktrees/bos/feat/<id>/`). `git worktree add` accepts it, but prune/cleanup and the "startup sweep" (P2.8) must walk nested paths, and two features `bos/feat/a` and `bos/feat/a/b` could interact oddly. Encode the branch to a flat dirname, or state that nesting is intended and cleanup handles it.

### N7 — (Minor, carried over) Back-compat for existing installed-app manifests and adopted-store id collisions
- `AppManifest` gains required-ish `runtime`/`source` (P4.1). Existing GitFS-installed apps have manifests without them — specify the default (`runtime:'iframe'`, `source:'local'`) so pre-027 installs still resolve.
- Adopted specs fork into user-specs; two adoptions (or an adoption colliding with an existing user store id) need a de-dup/rename rule. Unspecified.

### N8 — (Minor) Runtime-authored system specs live under `specs/`, not `seed/spec-store/`
This very spec (027) sits in `specs/bos-system-specs/` — the runtime container — not in `seed/spec-store/` (the source home). Under Option B, promoting a system-spec change is a source edit to `seed/spec-store/` (US5 test asserts this). Worth one sentence in the migration note on how in-flight system specs authored under the old writable model get lifted into `seed/spec-store/`, so the transition doesn't strand them.

---

## Summary

The revision is a substantial, high-quality response: it made the right architectural call (adopt 020, don't fork it), picked a clean and defensible system-spec policy (Option B), fixed the concurrency races with a proper single-writer, and added a security model (opaque-origin + capability broker) that is *more* robust than what v1 asked for — all consistent with the actual code.

**Before implementation, address:**
- **N1** (two-worktrees-per-branch transition) — real correctness gap in the adopted model.
- **N2** (system-spec seed must mirror, not merge) — concrete, or read-only system specs silently go stale.
- **N3** (tighten the "unmodified apps just work" claim; the sync-storage/network limits are real).

**Strongly consider:**
- **N4** — split the sandbox/SDK/marketplace scope out so the P1 user-specs relocation ships on its own; at minimum unbundle bastion from Phase 6.
- **N5** — add a Supervisor-repoint / LVC verification.

**Minor:** N6 (worktree naming), N7 (manifest back-compat, adopted-id collisions), N8 (in-flight system-spec migration note).

No blockers remain. With N1–N3 resolved (and ideally the N4 split), this is ready to build.
