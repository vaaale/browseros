# Extending BOS — recipes

Concrete, copy‑the‑pattern guides. Each links to the subsystem page for detail.
Always `npx tsc --noEmit` + `npm run lint` after, and update the relevant
`docs/usage` / `docs/dev` page (served by the Docs app) and `specs/` file.

---

## Add a built-in app

1. `src/apps/<id>/manifest.ts` — `export default` an `AppManifest` (folder name ==
   `id`; valid lucide `icon`; `singleton?`, `order?`).
2. `src/apps/<id>/index.tsx` — `"use client"`, default‑export an `AppProps`
   component. Keep content selectable.
3. `gen-apps.mjs` auto‑discovers it on `predev`/`prebuild` — no registry edit.
4. Persistence? Add a `server-only` store under `src/lib/...` (atomic writes under
   `data/…`) + an `/api/...` route; call via `fetch`.

→ [Apps guide](./guides/apps.md)

---

## Add a Settings tab (and an assistant config tool)

1. Add a `ConfigRegistration` to `REGISTRATIONS` (`src/lib/config/registry.ts`) with
   a `schema` (`namespace`, `title`, `order`, `fields`/`customComponent`) and
   `load`/`save` (simple cases: `patchNamespace`).
2. Custom UI → component in `src/components/apps/settings/` mapped in `CUSTOM_TABS`
   (`src/apps/settings/index.tsx`).
3. Mark secrets `secret: true`. Fields are auto‑exposed via `config_set`.

→ [Configuration system](configuration/configuration-system.md)

---

## Add an assistant action (tool)

1. `useCopilotAction({ name, description, parameters, handler })` in the best
   `*Actions.tsx` (handler → `/api/...`).
2. Mirror it in `src/lib/agent/tool-manifest.ts` (Tools panel).

→ [Actions & tools](assistant/actions-and-tools.md)

---

## Add an API route

`src/app/api/<area>/route.ts`. Server‑only logic in `src/lib/...` (`import
"server-only"`). Persist under `data/…` with `writeFileAtomic`. Mask secrets in
responses. Stream with NDJSON if long‑running.

→ [API reference](api-reference.md)

---

## Add a sub-agent / make one able to edit source

- `agent_create` (action) or a `DEFAULTS` entry in
  `src/lib/agent/subagents/store.ts`. Coding agents → `type:"claude"`.
- A local agent can be granted the repo‑scoped **read‑only** `DEV_TOOLS`
  (`bos_source_list`/`bos_source_read`/`bos_source_search`, `dev_git_status`) by
  listing those ids in its `tools` — never granted implicitly. Source *writes* are
  not a tool: only the Claude/OpenCode dev harness edits BOS source (via its native
  file tools, in a Supervisor worktree). `run_command` (sandboxed exec) is injected
  per delegated run when the agent lists it.

→ [Sub‑agents & delegation](assistant/sub-agents-and-delegation.md)

---

## Add server boot-time initialization logic

1. Put the logic directly in `src/instrumentation.ts`'s `register()` — **not**
   a bare new file that you assume Next.js will discover on its own.
2. Next only ever calls the `register()` exported from the file literally named
   `src/instrumentation.ts`, and a root-level `instrumentation.ts` silently
   displaces it. Do not create either a sibling boot file or a root one; both
   have already killed this boot sequence once each. The whole body is gated on
   `process.env.NEXT_RUNTIME === "nodejs"`.
3. **Verify it actually ran** — check the logs for output your code produces,
   or check that a file/directory it's supposed to create/read exists on
   disk. Don't stop at "the code compiles and looks wired up": an entire
   boot sequence (service seeding, registry init, scheduler start) silently
   never ran for a while despite looking correct, because the previous
   `instrumentation.ts` was a no-op stub.

→ [Design heuristics](design-heuristics.md)

---

## Add a service (background daemon)

1. `<item-id>/services/service.json` — manifest (`id` must equal the folder
   name, `entry` relative to `services/`) + `<item-id>/services/<entry>` — a
   worker script. Guard every top‑level `parentPort` use with
   `if (parentPort) { ... }` — the entry is also `import()`ed from the main
   thread at start time (CH‑011).
2. `<item-id>/config/` (required, may be empty) — default config file(s).
   Optional `app/` (bundled iframe UI), `spec/`, `doc/`.
3. Place it directly under `dataDir()/user-apps/items/<id>/` — the user's own GitFS
   repo (the same concept as `user-specs/`; BOS never seeds or deletes from
   it) — or install it via a marketplace item's `services.entrypoint`.
   Installing creates symlinks under `dataDir()/system/` — it does not copy
   or otherwise modify the item's source.
4. It shows up in Settings → Plugins → Services automatically once installed;
   no registry edit needed.
5. If the item bundles its own `app/` and that app needs to reach BOS APIs
   (e.g. to read its own service's bound port), it must go through the
   `window.__bos` broker + a granted `AppCapability` once installed as a real
   app — a direct `fetch()` breaks under the `marketplace`-origin sandbox. See
   [Apps guide](guides/apps.md#trust-tiers-the-sdk--sandbox-028).
6. **Start the service through the real API (`npm run dev`) and confirm it
   reaches `"running"`** — the unit test suite runs in plain Node and won't
   catch a Turbopack-only failure like a bundler intercepting `new
   Worker(...)`. Green tests alone are not sufficient here.

→ [Service Daemons](apps/services.md)

---

## Add a hook-based plugin (agent-run pipeline)

1. Implement `PluginDefinition` (`src/lib/plugins/types.ts`) — a manifest plus
   whichever `BosPluginHooks` you need (`beforeRun`/`extendSystemPrompt`/
   `beforeToolCall`/`afterToolCall`/`afterRun`/`onRunFinished`/`onError`).
2. Register it: built-ins do this via a tiny `init.ts` that calls
   `registerPlugin(def)` at import time (see `src/plugins/compaction/init.ts`);
   import that `init` module from both `src/instrumentation.ts` and
   `src/app/api/plugins/route.ts`.
3. It appears in Settings → Plugins automatically (toggle, reorder, configure).

→ [Plugin pipeline](plugins/plugin-pipeline.md)

---

## Add a skill (seed)

Add to the seed list in `src/lib/agent/skills/store.ts` (or create at runtime via
`skill_save`). Frontmatter `name/description/whenToUse`; body = the procedure;
optional `references/` and `scripts/`.

→ [Self‑improvement](self-improvement/self-improvement.md)

---

## Modify a BOS feature (the agent path)

Delegate to the `developer` (Claude) agent — never the local model, never via the
VFS. It works on a feature branch (`startFeatureBranch`), edits under `src/`,
typechecks, stages. Under the Supervisor the change is built as a **preview** (the
feature branch in its own worktree, alongside the running **base**) that the user
previews then promotes or stops.

→ [Modifying BOS](../usage/building-and-modifying/modifying-bos.md) ·
[Live version control](self-modification/live-version-control.md)

---

## Build an app or service for the user (the agent path)

`app_install`/`app_build` install a full marketplace ITEM, not just an app — an
item may bundle an `app/` facet, a `services/` facet, or both together.

- **Static (app only):** delegate (`contentOnly:true`) → one `index.html` →
  `app_install({ name, html })`.
- **Project (app and/or service):** delegate (`contentOnly:true`) to write a
  staging directory whose root IS the item root — `app/` (e.g.
  `app/src/main.tsx`), `services/` (`service.json` + entry script), `config/`
  as needed — then `app_build({ name, dir, entry? })` (`/api/apps/build`):
  bundles the app facet's entry with esbuild if present, installs the whole
  item behind one symlink, and validates/registers/auto-starts a `services/`
  facet the same way a Marketplace-triggered service install does. A
  services-only item (no `app/` at all) is a fully valid build.

→ [Installed apps](./apps/installed-apps.md) · [Service Daemons](./apps/services.md)
