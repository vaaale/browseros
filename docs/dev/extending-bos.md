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

## Build an app for the user (the agent path)

- **Static:** delegate (`contentOnly:true`) → one `index.html` → `app_install({ name,
  files })`.
- **Project:** delegate (`contentOnly:true`) to write a project dir → `app_build`
  (`/api/apps/build`) → esbuild bundle → `app_install({ files, entry }, {draft})`.

→ [Installed apps](./apps/installed-apps.md)
