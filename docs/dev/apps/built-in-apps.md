# Built-in apps

Built‑in apps are **first‑class React components compiled into the BOS bundle** —
the OS's own apps (Files, Browser, Assistant, Memory, Docs, Settings). They differ
from [installed apps](installed-apps.md), which are sandboxed iframes served from
GitFS.

---

## Anatomy

Each built‑in app is a self‑describing folder `src/apps/<id>/`:

- **`manifest.ts`** — `export default` an `AppManifest`. **The folder name must
  equal the `id`.** Use a valid lucide `icon`, `defaultWidth`/`defaultHeight`,
  `order?` (desktop/dock position), and `singleton?`.
- **`index.tsx`** — `"use client"`, `export default` a component taking `AppProps`
  `{ windowId, appId, params }`. Keep content **text‑selectable**.

---

## Auto-discovery (`tools/gen-apps.mjs`)

There is **no central registry to edit**. `tools/gen-apps.mjs` runs on
`predev`/`prebuild` (or `npm run gen:apps`) and scans `src/apps/*`, writing two
gitignored files:

- `src/apps/_manifests.generated.ts` → consumed by `src/os/apps.ts`
  (`BUILTIN_APPS`, sorted by `order` then name).
- `src/apps/_components.generated.ts` → consumed by
  `src/components/apps/registry.tsx` (`getAppComponent(id)`).

So **dropping a folder** under `src/apps/` is all it takes — the same "an app is a
folder with a manifest" model as installed apps.

---

## The shipped built-ins

| id | name | icon | order | singleton | notes |
|---|---|---|---|---|---|
| `files` | Files | `Folder` | 10 | no | VFS browser/editor; image preview; set‑wallpaper |
| `browser` | Browser | `Globe` | 20 | no | proxy web view |
| `chat` | **Assistant** | `Bot` | 30 | yes | the CopilotKit chat |
| `memory` | Memory | `Brain` | 40 | yes | user profile + agent memory editor |
| `docs` | Docs | `BookOpen` | 50 | yes | in‑OS docs hub reader |
| `settings` | Settings | `Settings` | 60 | yes | config tabs |

> Note the built‑in chat app's `id` is **`chat`** but its display name is
> **"Assistant"**. Launch it with `launchApp("chat")`.

---

## Persistence

If an app needs server‑side persistence, add a `server-only` store under
`src/lib/...` writing under `data/…` (atomic via `writeFileAtomic`) plus an
`/api/...` route, and call it from the client with `fetch`. Prefer an existing
storage layer (config namespace, VFS, memory/skills) over inventing a new path —
see [Design heuristics](../design-heuristics.md).

---

## Recipe: add a built-in app

1. `src/apps/<id>/manifest.ts` — `export default` an `AppManifest` (`id` == folder
   name; valid `icon`).
2. `src/apps/<id>/index.tsx` — `"use client"`, default‑export an `AppProps`
   component. Keep text selectable.
3. Done — `gen-apps.mjs` discovers it (runs on `predev`/`prebuild`); it appears on
   the desktop/dock and is launchable via `launchApp`.
4. If it needs persistence, add a server store + `/api/...` route.
5. Update `docs/usage`/`docs/dev` (served by the Docs app) and, if it adds tools, `tool-manifest.ts`.
