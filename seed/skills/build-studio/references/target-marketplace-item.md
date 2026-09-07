Target: An ITEM that lives in the user's private marketplace, `data/user-apps/items/<id>/` — an app facet, a background service facet, or both together in the SAME item — NOT a BOS source change.

Read this one carefully — its mechanics are genuinely different from `target-bos-core.md`/`target-builtin-app.md`, and mixing them up is the most common way this goes wrong. Do NOT treat "app" and "service" as separate targets needing separate delegations: they are two facets of one item, installed by the same one symlink, via the same one tool call. Most non-trivial items have both — a background daemon almost always wants a companion UI (settings, status, token management), and a "just an app" idea often turns out to need a background piece once you look closely. Classify what facets this item needs; don't force a choice between "app" and "service" that the spec doesn't actually require.

**Precedent** — the Terminal item (`items/terminal/`), a real installed marketplace item with BOTH facets, not BOS source:
```
terminal/
├── app/index.html       # companion UI, same item, opened as a normal installed app
├── services/
│   ├── service.json      # {id, entry, configSchema: {port, host, ...}, settingsRegistration}
│   └── index.js          # the actual daemon — plain Node, its own WebSocket/HTTP server
├── docs/
│   ├── usage/Terminal/…  # end-user pages — shown in the Docs app once installed
│   └── dev/Terminal/…    # developer pages — same
└── config/
    ├── terminal.json      # user-editable config (seeded from the item's config/ defaults)
    └── runtime.json       # BOS-written: the actually-bound port when configured as 0
```
This is the normal shape, not a special case. Design toward "what facets does this item need" (app? service? both?), not toward picking one of two competing target categories.

## The facts that make this different from BOS-core/built-in work

1. **A feature branch IS required — but still no `dev_delegate`.** `data/user-apps` is branch-coupled exactly like a spec store: it mounts as a worktree on the active `bos/*` branch and promotes/discards with it. So **call `dev_branch_request` FIRST**, before any `app_spec_*` write and before any `app_install`/`app_build` — all of them are refused without an active branch. This changed: item work used to be branch-free.

   Elicit the branch YOURSELF, before delegating. A sub-agent CAN call `dev_branch_request` (it is routed to the user through the parent run) — but only if that agent's own tool list includes it, and several spec-writing agents' lists don't. Eliciting up front means the delegation never stalls on a refusal the sub-agent may be unable to resolve.

   `dev_delegate` is still wrong here: it forces the BOS-source worktree path. Use `agent_delegate` (`contentOnly:true`) for the content, and do the branch + install yourself.
2. **You finish the install yourself.** You have `app_install`, `app_build`, `app_list` and `app_uninstall` in your own toolset. The Developer never installs anything — it only produces content (an HTML document, or a staged project directory describing one or both facets) and reports back; you call the install tool, which installs the FULL item, whatever facets it has.
3. **Your `file_*` tools cannot reach `data/user-apps` at all** (they're VFS-mounted to `/Specs`, `/Docs`, `/Templates`, and the user's sandbox only) — that boundary still applies to an item's CODE. Never try to `file_write`/`file_edit` an item's app/service/plugin files, and never hand-write `app.json`/`service.json` or a symlink — `app_install`/`app_build` are the only mechanism that writes those into `data/user-apps/items/<id>/`, commits it, and creates/refreshes the `data/system/<id>` symlink. The item's **spec** is the one exception: it lives inside the item too (`data/user-apps/items/<id>/spec/spec.md`), but you reach it through the dedicated `app_spec_create`/`app_spec_read`/`app_spec_write`/`app_spec_edit`/`app_spec_patch` tools instead of `file_*` — never `file_write` there either, and never through `app_install`/`app_build` (those are for code facets, not spec content).

## Before you conclude a service facet needs BOS source instead

This is the single most important judgment call for anything with a background/protocol/daemon component, and it has already gone wrong for real once: a spec for mounting the VFS over WebDAV reasoned "Next.js route handlers reject non-standard verbs (PROPFIND, MKCOL, COPY, MOVE), therefore this needs `src/middleware.ts`" — true about Next.js, and still the wrong conclusion, because the answer sidesteps Next.js entirely.

A marketplace item's `services/` facet (`user-specs/002-service-daemons`, implemented — `ServiceRegistry.ts`, `ServiceManager.ts`) is a **plain Node worker thread, bound to its own configurable port, running entirely outside Next.js**. `ServiceManager.ts` starts it with `new Worker(entryPath)` against the item's own `services/<entry>` file — loaded completely outside the Next.js/webpack bundle. It is not a Next.js route, not middleware, not subject to the App Router's fixed HTTP-method set. Any requirement like "must handle an arbitrary/non-standard protocol," "must accept HTTP verbs Next.js doesn't recognize," or "must run continuously in the background" is a strong signal for a service facet, NOT a reason to add routing/middleware to `src/`. Terminal's WebSocket daemon binds its port directly in `services/index.js` using plain Node — no `src/` involvement, no Next.js in the loop at all. A WebDAV daemon (or any other raw-protocol service) should look exactly like this: handler/auth/normalize/per-method logic all live inside `services/` as plain Node modules, bound to their own port, not inside a new `src/` tree.

Two supporting facts, both easy to get wrong:
- A native client connecting to the service (a WebDAV client, a WebSocket client, an SSH-like tool) is not a browser page and is not bound by same-origin/CORS — for **local/same-network deployments** it can connect directly to the service's own port, and a companion Settings/app UI can read that port from `GET /api/services/<id>/config`'s `runtime` field. **For a multi-user or reverse-proxied deployment (Bastion, Dokploy, Traefik/nginx), the service's own port is NOT directly reachable at all** — only the Supervisor's single public port is exposed/TLS-terminated there. **This is already solved, not a gap to route around or hand-wave past**: `GET /api/services/<id>/config` also returns `wsPath`/`httpPath` fields (non-null whenever a Supervisor fronts BOS) that proxy through the Supervisor to the service's actual port — `wsPath` for WebSocket traffic, `httpPath` for everything else, including non-standard-verb protocols like WebDAV that a Next.js route handler could never express. **Mandatory before writing any spec/plan/task for a service with its own network port**: `skill_read_file` on `docs/dev/apps/services.md` §11 (the reachability mechanism, both cases, plus the client-side pattern) — do not guess or invent a URL/path for this; a past session fabricated a `/services/<id>/` path that looked plausible, passed typecheck, and 404'd for every real user. If `wsPath`/`httpPath` genuinely don't cover a need you've verified against that doc, surface the gap to the user rather than building a workaround in `src/`.

- **Any configurable port a service's `configSchema` exposes MUST default to `0`, never a fixed number.** `0` means "the OS assigns a free port" — the only thing that's guaranteed never to collide with BOS's own reserved ports (the Supervisor's public port, the base branch's own port, and its preview-worktree pool — see `docs/dev/apps/services.md`'s "Choosing a port" section for the exact reserved ranges). This isn't a style preference: Terminal's own shipped default was a fixed `3001` — the first slot of the default preview pool (`3001-3020`) — and it took a real production incident to catch. `ServiceManager` now refuses to start a service whose configured port collides with a reserved one (surfaced as a visible error in Settings → Plugins → Services, not a silent failure), but a spec/plan/design should never rely on that safety net by proposing a fixed default in the first place.
- A design/mockup/config-UI that shows a user a connection URL must describe all three deployment scenarios in `docs/dev/apps/services.md`'s "The three deployment scenarios, spelled out literally" table (Bastion, Supervisor-only, standalone) — not just whichever one you happened to test against, and never a specific port number for the standalone case (it's OS-assigned and changes every restart).

**There is no such thing as a service that skips binding a port.** Every worker-thread service binds a real port — that's the only thing the Supervisor's proxy has to forward to. This matters especially when YOU (Build Studio) are writing a "fix"/"redo" task back to `architect` mid-review: a past session did exactly this — asserted, without ever citing `docs/dev/apps/services.md`, that a WebDAV service "does NOT bind a port or host" and is "exposed entirely through a path-proxy mechanism" (a mechanism that doesn't exist anywhere in BOS), then forced `architect` through several revision rounds to strip out an earlier, correct port-based design to match that fabrication. If you're about to tell `architect` a service works some other way than binding a port, verify it against this doc first — your own delegation task is not exempt from the same "don't guess a mechanism" rule you're enforcing on `architect`.
- A worker-thread service entry runs **unbundled, outside the `@/` module graph** — it cannot `import` a BOS-source TypeScript module (e.g. `@/lib/secrets/service-secrets`) the way an app or a Next.js route can. **If the service needs to authenticate a headless client's presented credential, do NOT hand-roll a self-contained token scheme (generate/hash/store your own in the item's own `config/`)** — that was this doc's own prior guidance and it shipped a real bug: a token hashed and verified entirely inside the worker thread is never registered in `credentials-index.json` (only `createSecret()` writes that), so Bastion's headless-auth routing rejects every request at the front door before it ever reaches the service's own check, no matter how correct that check is. Use the loopback bridge instead — `docs/dev/features/headless-client-auth.md`'s "Worker-thread services" section, mint/list/revoke via `/api/secrets/<service>` (called from the browser Settings page) and verify via a loopback `POST /api/secrets/<service>/verify` on every incoming request — the same shape as the VFS bridge below, and the only way the service's own code never has to think about token generation, hashing, or storage at all.

### Reaching the VFS from a service

The same unbundled-worker-thread limitation means a service can't `import "@/os/vfs"` either — and the answer is the same shape as everywhere else in this section: don't reimplement VFS logic (path-traversal protection, mount-table routing, atomic writes) inside the service, and don't drop into `src/` to get it. Call BOS's own VFS HTTP API via a plain loopback request instead (`fetch('http://localhost:<port>/api/fs...')`) — a server-to-server call within the same container, not a browser request, so none of the same-origin/CORS sandboxing above is relevant:
- **Small/metadata operations** (list, stat, mkdir, delete, rename, small file read/write — i.e. most WebDAV methods: PROPFIND, MKCOL, DELETE, MOVE, COPY) → `/api/fs` (`GET ?op=list|read`, `POST {op: write|mkdir|delete|rename}`).
- **Large file GET/PUT** → `/api/fs/raw` (`GET ?path=`, `PUT ?path=`) — both stream; neither buffers the whole file in memory on either side (`vfs.ts`'s `readStream`/`writeStream`). This is what satisfies a "don't buffer 100MB+ files in memory" success criterion — use it for anything beyond a trivially small file, not the JSON `/api/fs` route.
- No special headers/auth needed for plain VFS content (`Documents/`, etc.): the branch-scope headers `/api/fs` reads only matter for the branch-coupled mounts (`/Specs`, `/Docs`), which a service almost certainly shouldn't be exposing anyway. Isolation is already provided by the per-user container boundary in a multi-user deployment — the service can only ever reach its own container's VFS.

(Other facets — `plugin/` (agent-run hook pipeline), `hooks/`, `spec/` — are also installed by this same one mechanism if a spec ever calls for one; see `docs/dev/plugins/plugin-pipeline.md` for that facet's own authoring conventions. This reference focuses on the three common facets: app, service, and docs.)

## The `docs/` facet — REQUIRED for every item

**Every item you build ships its own documentation, inside the item.** This is not optional polish and not a followup: an item with no `docs/` facet is an incomplete build, the same way an app with no UI would be. BOS's Docs app overlays each installed item's docs onto its own two trees at read time, so the pages appear for the user as soon as the item is installed and disappear when it is uninstalled — nothing is copied into BOS's source and nothing is symlinked.

The layout is fixed, and getting it wrong is the failure that made this rule explicit — the Workflows item shipped `usage.md`, `tool-reference.md` and `examples/` loose at the top of its own `docs/`, with only the developer pages in a `dev/` folder and neither audience namespaced, and none of it was readable in the Docs app:

```
<item>/docs/
├── usage/<Name>/…      # END USERS: what it does, how to use it, settings, troubleshooting
└── dev/<Name>/…        # DEVELOPERS/AGENTS: architecture, data model, extension points
```

**`<item>` is the item's OWN root, never BOS's repo.** Every `docs/…` path in this section is relative to it. Concretely that root is the fresh staging directory while the Developer is authoring (Step 1), and `items/<id>/` inside the user's `user-apps` marketplace repo once `app_build` has installed it. BOS's source tree has a `docs/usage/` and `docs/dev/` too, and they are a DIFFERENT, unrelated place that this job never writes to — the Docs app merges the two at read time, which is what makes them look like one tree in the UI and is exactly why the paths are easy to confuse. When you need to talk about BOS's own pages below, they are written out as `BOS's own docs/…` to keep them apart.

Four rules, all load-bearing:

1. **Two audiences, always split.** Never one merged folder, never loose `.md` files at the top of `<item>/docs/`. The Docs app has exactly two trees (Usage / Developer) and reads only these two paths; anything else in the item is invisible.
2. **Exactly ONE folder per audience, named after the item as the USER sees it** — `Workflows`, not `workflows`, `workflow-manager`, or the slugified id. It is a UI label, rendered verbatim in the Docs sidebar. This folder is what keeps the item's pages together in the merged tree: a file at `<item>/docs/usage/troubleshooting.md`, with no `<Name>` folder, still lives in the item — but it RENDERS at the top level of the Usage tree, indistinguishable from BOS's own pages, and is silently dropped altogether if BOS ships a page of that name (BOS wins collisions).
3. **Same `<Name>` in both audiences.** A user switching Usage → Developer expects the same folder to be there.
4. **The docs describe the SHIPPED item**, not the build. Skip the delegation history, staging paths and branch mechanics; write what someone opening the app needs.

Writing `docs/usage/<Name>/…` and `docs/dev/<Name>/…` into the delegation task is fine — those resolve inside the staging directory, so they are not BOS-source references. The `contentOnly` trip-wire in Step 1 fires only on a path that resolves to a page BOS actually ships (BOS's own `docs/dev/architecture-overview.md` and friends). What you must not do is ask the SAME delegation to touch one of those: a `contentOnly` run works in the live source checkout, so a BOS-docs edit there lands off-branch and unversioned. Deleting superseded core pages is a separate, ordinary `dev_delegate` — see below.

**When an item REPLACES something that used to live in BOS core**, the core pages do not stay behind as a courtesy — say so explicitly in your summary to the user and get them deleted from BOS's own `docs/usage/` and `docs/dev/` (a separate, ordinary `dev_delegate`, since deleting THOSE is a BOS source change — see `target-bos-core.md`). This is the one time this job touches BOS's docs tree at all, and it is a deletion, never a write. Two live copies of the same documentation is the failure mode; the item's copy is the one that ships with the code. This has already gone wrong once: the Workflows engine moved out of BOS core into an item, and its retired pages sat in BOS's own `docs/` alongside the item's for weeks.

## Step 1 — delegate content generation

This task text has to be a self-contained description, not a spec path — do NOT write "read the spec at specs/.../" here. That's a real structural difference from `target-bos-core.md`/`target-builtin-app.md`, not an inconsistency: `specs/<store>/<id>/` is only ever mounted into the isolated worktree the Supervisor provisions for a non-`contentOnly` `dev_delegate` call; a `contentOnly:true` run never provisions a worktree at all, so there is nowhere for the Developer to read the spec from. If a spec exists, distill it yourself into a short, plain-language description of what's needed — the item's purpose, its facets (app UI? background daemon? both?), main views/actions, what it persists — not a copy-paste of the whole spec.

Call `agent_delegate` with `agent:"developer"`, `contentOnly:true`. This is critical and easy to get subtly wrong: whether the harness treats the call as content-only or refuses it is decided by literally matching substrings in your `task` text (case-insensitive), not just the `contentOnly` flag.

- Your `task` MUST contain one of these phrases (verbatim or close to it): "standalone app", "self-contained index.html" (or "self contained index.html"), "write a bos app project", "staging directory" / "staging dir".
- Your `task` MUST NOT contain any of: "built-in app" / "built in app", "settings tab", "api route", "server logic", "bos source" / "browseros source" / "bos's own source" / "browseros's own source", or any path fragment matching `src/app/`, `src/apps/`, `src/components/`, `src/lib/`, `src/os/`, `src/store/`. This is a plain substring check — even a NEGATION like "this is not a built-in app" contains the trip-wire phrase "built-in app" and will get the delegation refused with "Refusing contentOnly developer harness run." Just don't say any of those words in the task text; describe the item in plain product terms instead.
- One trip-wire is NOT a plain substring check: a `docs/dev/...md` path is refused only if it resolves to a page BOS itself ships. So the item's own `docs/usage/<Name>/…` and `docs/dev/<Name>/…` are safe to write out in full, while "also update `docs/dev/architecture-overview.md`" (a page in BOS's OWN docs tree) is refused — that's a BOS source change and belongs in its own `dev_delegate`.

Pick the shape by what the item actually needs — an item can be any one of these, or the project shape can cover both facets at once:

**App only, trivial — one static HTML file:**
```
agent_delegate(agent: "developer", contentOnly: true, task:
  "Output ONLY a single self-contained index.html for this standalone app: <description>.
   All CSS/JS inline, no external dependencies, no CDNs, no network calls (same-origin BOS
   API calls via window.__bos are fine). Output nothing but the <!doctype html> ... </html>
   document — no prose, no code fence.")
```
Then extract the HTML (strip any wrapping prose/code fence if the model added one anyway) and call:
```
app_install({ name, html, icon })
```
This shape carries no `docs/` facet — `app_install` takes one HTML document and nothing else. Use it only for a genuinely trivial app whose whole behavior is self-evident; anything a user could need instructions for should be the project shape below, so it can ship documentation.

**Project — an app, a service, or both, plus docs, in one staging directory:**
```
agent_delegate(agent: "developer", contentOnly: true, task:
  "Write a BOS app project into a fresh staging directory (e.g. /tmp/<name>): the staging
   dir root IS the item root. If this item needs a UI, put it under app/ — an
   app/src/main.tsx (or app/src/main.ts) entry that mounts into
   document.getElementById('root'), plus any components/CSS alongside it under app/. If
   this item needs a background daemon, put services/service.json (id, entry,
   configSchema, settingsRegistration) and the entry script (plus any supporting modules)
   under services/. Include whichever of these the item actually needs — one or both. You
   may import React etc. for the app facet (provided to the bundler — do not npm install).
   Also write the item's documentation under a top-level docs/ folder, split by audience
   and namespaced by one folder named '<Name>': docs/usage/<Name>/*.md for end users (what
   it does, how to use it, settings, troubleshooting) and docs/dev/<Name>/*.md for
   developer/agent readers (architecture, data model, extension points). Both paths are
   relative to the staging directory. Do not put loose markdown files anywhere else under
   docs/, and do not touch any documentation outside the staging directory. Document the
   shipped item, not how it was built. Do not build or install anything; just report the
   staging directory path. Item: <description>.")
```
(`<Name>` is the item's display name — the same one you pass to `app_build`.)
Then call:
```
app_build({ name, dir: "<staging dir the Developer reported>", entry?, icon })
```
`entry` is relative to the app facet (`app/`) and defaults to `src/main.tsx`/`src/main.ts` if you omit it — i.e. it resolves `app/src/main.tsx`, not a bare top-level `src/main.tsx`. Omit it entirely for a services-only item (no `app/` facet at all) — `app_build` only resolves/bundles an entry when the item actually has an app facet.

## Step 2 — the install itself

Both `app_install` and `app_build` install the ITEM (not just an app facet):
- write the files into `data/user-apps/items/<id>/` at the paths given (`app/...`, and `services/...`/`config/...`/`docs/...` if the staged item has those),
- commit that to the user's own `user-apps` GitFS repo,
- create/refresh the ONE `data/system/<id>` symlink (the actual "installed" state — 035-install-by-symlink), esbuild-bundling the app facet's entry if one is given,
- and — if the staged item has `services/service.json` — validate, register, and auto-start the service the same way a Marketplace-triggered service install does.

There is no separate `service_install` tool, and none is needed — `app_build` (and `app_install` for the plain-static-HTML-app case, though that shape can never include a service) are the one mechanism for every item shape.

**The commit lands on the conversation's active feature branch, wherever you are running.** There is one mechanism now — the old singleton `app-candidate` branch and its separate "Promote app"/"Discard app" buttons are retired.

- The install content is written into that branch's own coupled `user-apps` worktree, so the user **stays on base** for the whole job: authoring the spec, delegating content, and installing all happen from base and all land on the branch.
- **Nothing runs in base as a result.** The item is not installed in the version you are talking to — there is no `system/<id>` symlink for it there — so it does NOT appear in the dock and there is no window to open. Do not tell the user to look for it. `app_install`/`app_build` will tell you which branch it landed on; relay that.
- To try it, the user builds that branch and opens its **Preview** (the ordinary feature-branch Promote/Stop/Discard controls, the same ones `target-bos-core.md`/`target-builtin-app.md` use). Promoting the branch makes the item live, together with any code and specs on it. You never promote or discard it yourself.
- A service facet on a branch install is validated but deliberately NOT started in the current version — the branch's preview starts it on boot. So don't tell the user to check Settings → Plugins → Services until they are on that preview.

Use `app_list` to confirm the id/status afterward, and `bos_app_launch` to open an app facet for the user to review. For a service facet, point the user at Settings → Plugins → Services to manage it (start/stop/restart/logs/config) — installing does not require them to do anything further, but starting/inspecting it lives there. For a docs facet, tell the user the pages are in the **Docs** app under a `<Name>` folder in BOTH the Usage and Developer trees — on the branch's preview, same as everything else on the branch.

## Choosing an id

The install namespace is flat and per-item: if `app_install`/`app_build` errors because the id already exists, that's an existing installed item (possibly the same one under active development) — ask the user whether they mean to update it (go to "Followups" below) rather than pick a different name and create a duplicate.

**Don't rely on that error alone to catch a collision.** An item's id is set once, at creation (default: a slug of its ORIGINAL name), and never changes again — even if the item's display name is later edited. If the user refers to an app by a name that isn't its original name (a rename, a shorthand, "the Editor app" for an item actually named "Agentic Text Editor"), `slugify(that name)` will not match the real id, `app_build` will find no collision, and it will silently create a second, separate, never-the-one-that's-installed item instead of updating the real one. Whenever the user's request is about an app that might already exist — not just explicit "followups" (below), any first mention of building/fixing/changing "the X app" — call `app_list` first and match by name/description before deciding whether to build fresh or pass an existing `id`.

`app_spec_create` (`references/specify.md`) shares that same flat namespace but refuses on three DISTINCT conditions, each needing a different response — don't treat every failure as "ask if they mean to update it":
- **"is a reserved item id"** — the id collides with an id BOS itself uses (e.g. `config`). Pick a different id; there is nothing to update.
- **"already installed from a marketplace, not your own"** — the id belongs to an item that came from a marketplace clone, not the user's own `user-apps`. A spec can only be added to the user's OWN local items; pick a different id (adding a spec to a marketplace-sourced item isn't supported).
- **"already has a spec"** — this is the one case that DOES mean "ask whether they want to update it": switch to `app_spec_read`/`app_spec_edit`/`app_spec_patch` on the existing spec instead of `app_spec_create`.

## Anti-pattern: don't have the Developer hand-write into `data/user-apps` instead

A BOS-source `dev_delegate` task (see `target-bos-core.md`) now runs in a worktree where `data/user-apps` (relative to the Developer's own cwd) is a real, writable, correctly branch-coupled path — a recent fix (`linkUserAppsIntoWorktree`) made this safe where it used to silently discard anything written there. That fixes a data-loss bug; it does NOT make hand-writing there a substitute for `app_install`/`app_build` — always have the Developer write to a FRESH staging directory (never the live item path directly) and finish with `app_install`/`app_build` yourself. Reasons this still matters even though `app_build` can install a full item: writing straight into the live path bypasses the install itself — no commit on the feature branch, no `system/<id>` symlink, no facet registration — and a stray direct write left behind after a failed/aborted delegation can confuse the next install. Keep the two concerns (BOS-source work, marketplace-item work) as separate delegations with separate destinations, even within the same conversation.

Relatedly: don't reach for `src/` just because a service facet needs raw protocol/continuous-process behavior Next.js can't provide — see "Before you conclude a service facet needs BOS source" above. That mistake and this one share the same root cause (treating a marketplace-item limitation as if it forced a BOS-source workaround), just at different steps.

## Followups / bug reports on an already-installed marketplace item

Same active feature branch as the original build (elicit one with `dev_branch_request` if this is a fresh conversation), still `contentOnly:true`. Relay the user's report immediately — do not read the item's files yourself to theorize first (you have no VFS mount there anyway). Three-step, mirroring the initial build:

1. **Call `app_list` and match the user's description to the real installed item — resolve its actual `id` before anything else.** Never assume the id from the name the user used; it may be a rename, a shorthand, or just not what the item was originally called. If nothing matches, say so rather than guessing.
2. `agent_delegate(agent:"developer", contentOnly:true, task: "...")` — tell the Developer it MAY read the current implementation in place at `data/user-apps/items/<id>/` (using the id from step 1, a real relative path in its working directory) to understand what exists, but it must WRITE the corrected version into a fresh staging directory (never edit those files in place) and report that directory. Describe the user's exact complaint. Keep the same phrasing rules as Step 1 of the initial build (trigger phrases present, trip-wire phrases absent).
3. Call `app_build({ name, dir, icon, id })`, passing the **id resolved in step 1** explicitly — never omit it here; omitting it falls back to slugifying `name`, which will not match the existing item unless its display name and original name happen to be identical. This overwrites the changed facet(s), re-bundles/re-activates as needed, and lands on the active feature branch for the user to preview and promote (see Step 2 of the initial build).

Say in the task text that the `docs/` facet must be restaged too, updated for whatever changed. A rebuild writes the staged files over the item and removes nothing, so omitting `docs/` does not lose the pages — it leaves the OLD ones in place, silently describing behavior the fix just changed. Stale docs are worse than absent ones, and nothing in the install will flag them.

Never patch `data/user-apps` files yourself, and never skip straight to `app_build` without the Developer round-trip — you have no way to produce corrected content yourself.

## Spec bookkeeping

`user-apps/marketplace.json` is maintained by BOS itself (reconciliation on install/create/uninstall) — you never hand-edit it. A marketplace item's spec.md is NOT centralized under `/Specs/user-specs/` — it lives inside the item itself (`item-<id>/spec.md` in `app_spec_*` tool paths, physically `data/user-apps/items/<id>/spec/spec.md`), created together with the item via `app_spec_create` at `specify` time (`references/specify.md`). Keep it the source of truth as usual through `clarify`/`design`/`plan`/`tasks` — read it with `app_spec_read`, update it with `app_spec_edit`/`app_spec_patch` (or `app_spec_write` for a full rewrite) — and make sure its **App Target** field says `marketplace-item`.
