# Extending BOS — recipes

Concrete, copy‑the‑pattern guides. Each links to the subsystem page for detail.
Always `npx tsc --noEmit` + `npm run lint` after, and update the relevant
`docs/usage` / `docs/dev` page (served by the Docs app) and `spec/` file.

---

## Add a built-in app

1. `src/apps/<id>/manifest.ts` — `export default` an `AppManifest` (folder name ==
   `id`; valid lucide `icon`; `singleton?`, `order?`).
2. `src/apps/<id>/index.tsx` — `"use client"`, default‑export an `AppProps`
   component. Keep content selectable.
3. `gen-apps.mjs` auto‑discovers it on `predev`/`prebuild` — no registry edit.
4. Persistence? Add a `server-only` store under `src/lib/...` (atomic writes under
   `data/…`) + an `/api/...` route; call via `fetch`.

→ [Built‑in apps](apps/built-in-apps.md)

---

## Add a Settings tab (and an assistant config tool)

1. Add a `ConfigRegistration` to `REGISTRATIONS` (`src/lib/config/registry.ts`) with
   a `schema` (`namespace`, `title`, `order`, `fields`/`customComponent`) and
   `load`/`save` (simple cases: `patchNamespace`).
2. Custom UI → component in `src/components/apps/settings/` mapped in `CUSTOM_TABS`
   (`src/apps/settings/index.tsx`).
3. Mark secrets `secret: true`. Fields are auto‑exposed via `updateSetting`.

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

- `createSubAgent` (action) or a `DEFAULTS` entry in
  `src/lib/agent/subagents/store.ts`. Coding agents → `type:"claude"`.
- A **local** agent that should edit source must list the repo‑scoped `DEV_TOOLS`
  ids in its `tools` (`read_source`/`write_source`/`edit_source`/`run_command`/…) —
  these are never granted implicitly.

→ [Sub‑agents & delegation](assistant/sub-agents-and-delegation.md)

---

## Add a skill (seed)

Add to the seed list in `src/lib/agent/skills/store.ts` (or create at runtime via
`saveSkill`). Frontmatter `name/description/whenToUse`; body = the procedure;
optional `references/` and `scripts/`.

→ [Self‑improvement](self-improvement/self-improvement.md)

---

## Modify a BOS feature (the agent path)

Delegate to the `developer` (Claude) agent — never the local model, never via the
VFS. It works on a feature branch (`startFeatureBranch`), edits under `src/`,
typechecks, stages. Under the Supervisor this becomes a previewable **candidate**.

→ [Modifying BOS](../usage/building-and-modifying/modifying-bos.md) ·
[Live version control](self-modification/live-version-control.md)

---

## Build an app for the user (the agent path)

- **Static:** delegate (`contentOnly:true`) → one `index.html` → `installApp({ name,
  files })`.
- **Project:** delegate (`contentOnly:true`) to write a project dir → `buildApp`
  (`/api/apps/build`) → esbuild bundle → `installApp({ files, entry }, {draft})`.

→ [Installed apps](apps/installed-apps.md)
