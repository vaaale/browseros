# API reference

All server endpoints (`src/app/api/**/route.ts`) plus the two non‑`/api` routes.
Handlers are server‑side; clients reach them via `fetch` (often from a
`useCopilotAction` handler). Routes that **stream** return **NDJSON** (line‑
delimited JSON), not a single body.

---

## OS shell

| Route | Methods | Purpose |
|---|---|---|
| `/api/fs` | GET (`op=list\|read`), POST (`op=write\|mkdir\|delete\|rename`) | VFS operations |
| `/api/fs/raw` | GET `?path=` | Raw VFS bytes (images, …) |
| `/api/fs/upload` | POST `multipart/form-data` (`path`, `files`) | Drag‑and‑drop upload target — writes one or more files into a VFS directory |
| `/api/fs/download` | GET `?path=` | Download a file as an attachment, or a folder as an in‑memory zip (recursive) |
| `/api/settings` | GET, PATCH | OS settings (`data/settings.json`) |
| `/api/config` | GET, PATCH | Config namespaces (schemas + values; PATCH a namespace) |
| `/api/health` | GET | `{ ok: true }` — Supervisor health gate |
| `/api/system/setup` | POST | First‑run wizard: seed provider/harness/datafs |
| `/api/system/git` | POST | Scoped git ops (status/branch/stage) |

## Apps

| Route | Methods | Purpose |
|---|---|---|
| `/api/apps` | GET, POST, DELETE (`?purge=1`), PATCH | Installed apps: list / install / uninstall|purge / restore |
| `/api/apps/build` | POST | Build & install a project app (`readProjectDir` → esbuild → `installApp`) |
| `/apps/[[...slug]]` | GET | **Serve** an installed item's app files through its `data/system/<id>` item symlink (iframe content; `dist/` if built) |

## Services / plugins / marketplace

| Route | Methods | Purpose |
|---|---|---|
| `/api/services` | GET, POST, DELETE | List services (source + installed); install `{ itemPath, serviceId }`; uninstall `{ serviceId }` |
| `/api/services/[id]` | GET, POST | Detail (incl. `corruptedReason`); lifecycle `{ action: "start"\|"stop"\|"restart", reason?, startupTimeout?, shutdownTimeout? }` |
| `/api/services/[id]/config` | GET, PATCH | Config files + `runtime.json` + `readOnly`; auto-save `{ file, patch }` |
| `/api/services/[id]/logs` | GET | Service log file content |
| `/api/services/[id]/app` | GET | Serves the item's bundled `app/index.html` (404 if none) |
| `/api/services/events` | GET | NDJSON `ServiceRegistryEvent` stream (`?since=` replay) |
| `/api/plugins` | GET, PATCH, PUT, DELETE | List; toggle/reconfigure one `{ pluginId, active?, config? }`; reorder `{ orderedIds }`; uninstall `{ pluginId }` |
| `/api/marketplace` | GET, POST | GET returns registered marketplaces + catalogue **and `installedItemIds`** (the 035 scan); `op` in `{ add, remove, sync, adopt-spec, install-item, install-skill, uninstall-item, uninstall-plugin }` (`{ id, itemId }` for item ops, `{ itemId }` for `uninstall-item`; `{ url }` for `add`) |
| `/api/items` | GET | Installed ITEMS from the one shared scan (035): id, name, facets, origin, `broken`. The read surface for shapes with no registry of their own — a plugin-only item appears in neither `/api/apps` nor `/api/services` |

See [Service Daemons](apps/services.md) and [Plugin pipeline](plugins/plugin-pipeline.md)
for the underlying architecture.

---

## Assistant / agents
delegate
| Route | Methods | Purpose |
|---|---|---|
| `/api/copilotkit` | POST | CopilotKit runtime (per‑request adapter + MCP) |
| `/api/llm/openai/[...path]` | POST | OpenAI proxy: Chat Completions, `max_tokens`, `reasoning_content` → `<think>` |
| `/api/agent/provider` | GET, PATCH | AI provider config (key **masked**) |
| `/api/agent/provider/test` | POST | Test provider connection |
| `/api/assistant/agent` | GET, PATCH, POST | Agents + composed instructions; set active; create |
| `/api/assistant/feature-branches` | GET, POST | List/create validated `bos/<kebab-name>` feature branches for Assistant conversations |
| `/api/assistant/title` | POST | Background conversation title (isolated, sanitized) |
| `/api/assistant/reflect` | POST | Self‑improvement review pass |
| `/api/subagents` | GET, POST, DELETE | Sub‑agent registry |
| `/api/subagents/delegate` | POST | Run a sub-agent (**NDJSON** stream). Developer/source edits require a server-resolved active `featureBranch`; chat passes `conversationId` only for lookup |

## Memory / skills

| Route | Methods | Purpose |
|---|---|---|
| `/api/memory` | GET, POST, DELETE | Curated memory (`{user, memory}`; add/replace/remove) |
| `/api/skills` | GET, POST, DELETE | Skill CRUD (+ scripts/references) |
| `/api/skills/improve` | POST | GEPA‑lite skill improvement |
| `/api/skills/curator` | POST | Archive stale agent‑created skills |

## MCP / docs / data isolation / dev harness

| Route | Methods | Purpose |
|---|---|---|
| `/api/mcp` | GET (`?probe=`), POST, DELETE | MCP server list + probe |
| `/api/docs` | GET | Read‑only project docs tree (`docs/usage` + `docs/dev`) |
| `/api/datafs` | GET | Filesystem isolation capabilities/methods |
| `/api/dev-harness` | GET, POST | Dev‑harness config + test probe |

## Web proxy

| Route | Methods | Purpose |
|---|---|---|
| `/api/proxy/[[...path]]` | GET | Browser‑app proxy (path‑based; HTML/CSS rewrite; SSRF guard) |

---

## Supervisor (separate process, not Next.js)

Served by `tools/supervisor/supervisor.mjs` on the public port at `/__supervisor`:
`state`, `branches`, `preview-changes` (alias `next-changes`), `logs`, `pin`, `begin`,
`build`, `activate`, `promote`, `stop`, `discard`, `push`.
There is **no `rollback`** endpoint (deferred;
every promote leaves a `bos/v<timestamp>` tag as the anchor for it). See
[Live version control](self-modification/live-version-control.md).

---

## Conventions

- **Secrets never leave the server:** `/api/agent/provider` and `/api/config` blank
  secret fields; the OpenAI proxy keeps the real key server‑side.
- **VFS jail:** `/api/fs*` only touch `data/vfs` — never BOS source.
- **Streaming:** `/api/subagents/delegate` is NDJSON.
