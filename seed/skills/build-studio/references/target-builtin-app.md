Target: A built-in app living in the BOS source tree (`src/apps/<id>/`).

This is a special case of "modifications to BOS itself" — the delegation mechanics (feature branch, `dev_delegate`, Supervisor preview worktree, hot reload, Topbar Promote/Stop/Discard) are IDENTICAL to `references/target-bos-core.md`; read that first. This reference only covers what's specific to a built-in app.

## When built-in is the right call (vs. a marketplace item)

Document the choice and rationale in spec.md (Phase "Functional Design" of the `bos-app` skill asks for this). Prefer built-in when:
- The app needs direct OS state, Settings/config, or internal BOS APIs.
- The UI is primarily a thin wrapper around a BOS subsystem (e.g. Files, Settings itself).
- It should ship as part of BOS rather than be independently installable/removable.

Otherwise prefer `references/target-marketplace-item.md` — a self-contained user tool with its own lifecycle (whether it's just a UI, a background service, or both) should NOT become a built-in app just because it's convenient right now.

## Anatomy (what the Developer must produce)

```
src/apps/<id>/
  manifest.ts   # export an AppManifest: id, name, icon, default size, singleton, order
  index.tsx     # "use client"; default-export a React component taking AppProps
```

- The folder name MUST equal the app id.
- There is NO central registry to edit — `tools/gen-apps.mjs` discovers any folder under `src/apps/` containing both files and generates `_manifests.generated.ts`/`_components.generated.ts` on `predev`/`prebuild`/`npm run gen:apps`. Do not ask the Developer to register the app anywhere else.
- A built-in app is never installed via `app_install`/`app_build`, never gets a `data/system/<id>` symlink, and never lives under `data/user-apps/`. If you find yourself reaching for those tools, you've picked the wrong target — go to `references/target-marketplace-item.md`.
- If the app exposes assistant tools, that's a separate registration in the capabilities inventory (`docs/dev/guides/features-and-components.md`) — mention it in the delegation brief if the spec calls for it.

## Delegating implementation

Same as `target-bos-core.md`: ensure an active feature branch (`dev_branch_request` if none), then `dev_delegate` with the spec/plan/tasks PATH (per `references/implement.md`'s template — don't re-type its contents) plus one thing that genuinely isn't in the spec: an explicit instruction to follow the anatomy above (`manifest.ts` + `index.tsx`, folder name = id, run `npm run gen:apps` if needed, no manual registry edits).

## Problem reports on an existing built-in app

Relay immediately via `dev_delegate` with the user's report and the app id/folder (`src/apps/<id>/`). Do not read `index.tsx` yourself to diagnose first — the Developer does that on the worktree. Reuse the active feature branch if one already covers this app; otherwise set one up first.
