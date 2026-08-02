Target: An ITEM that lives in the user's private marketplace, `data/user-apps/items/<id>/` — an app facet, a background service facet, or both together in the SAME item — NOT a BOS source change.

Read this one carefully — its mechanics are genuinely different from `target-bos-core.md`/`target-builtin-app.md`, and mixing them up is the most common way this goes wrong. Do NOT treat "app" and "service" as separate targets needing separate delegations: they are two facets of one item, installed by the same one symlink, via the same one tool call. Most non-trivial items have both — a background daemon almost always wants a companion UI (settings, status, token management), and a "just an app" idea often turns out to need a background piece once you look closely. Classify what facets this item needs; don't force a choice between "app" and "service" that the spec doesn't actually require.

**Precedent** — the Terminal item (`items/terminal/`), a real installed marketplace item with BOTH facets, not BOS source:
```
terminal/
├── app/index.html       # companion UI, same item, opened as a normal installed app
├── services/
│   ├── service.json      # {id, entry, configSchema: {port, host, ...}, settingsRegistration}
│   └── index.js          # the actual daemon — plain Node, its own WebSocket/HTTP server
└── config/
    ├── terminal.json      # user-editable config (seeded from the item's config/ defaults)
    └── runtime.json       # BOS-written: the actually-bound port when configured as 0
```
This is the normal shape, not a special case. Design toward "what facets does this item need" (app? service? both?), not toward picking one of two competing target categories.

## The facts that make this different from BOS-core/built-in work

1. **No feature branch, no BOS-source worktree, no `dev_delegate`.** Do NOT call `dev_branch_request` for this. `dev_delegate` always forces the BOS-source worktree path — using it here is wrong even if it "seems to work," because it drags in an unrelated feature-branch requirement and worktree the item doesn't need. Use `agent_delegate` instead.
2. **You finish the install yourself.** You have `app_install`, `app_build`, `app_list` and `app_uninstall` in your own toolset. The Developer never installs anything — it only produces content (an HTML document, or a staged project directory describing one or both facets) and reports back; you call the install tool, which installs the FULL item, whatever facets it has.
3. **Your `file_*` tools cannot reach `data/user-apps` at all** (they're VFS-mounted to `/Specs`, `/Docs`, `/Templates`, and the user's sandbox only). Never try to `file_write`/`file_edit` an item's files, and never hand-write `app.json`/`service.json` or a symlink — `app_install`/`app_build` are the only mechanism that writes into `data/user-apps/items/<id>/`, commits it, and creates/refreshes the `data/system/<id>` symlink.

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

(Other facets — `plugin/` (agent-run hook pipeline), `hooks/`, `spec/` — are also installed by this same one mechanism if a spec ever calls for one; see `docs/dev/plugins/plugin-pipeline.md` for that facet's own authoring conventions. This reference focuses on the two common facets, app and service.)

## Step 1 — delegate content generation

This task text has to be a self-contained description, not a spec path — do NOT write "read the spec at specs/.../" here. That's a real structural difference from `target-bos-core.md`/`target-builtin-app.md`, not an inconsistency: `specs/<store>/<id>/` is only ever mounted into the isolated worktree the Supervisor provisions for a non-`contentOnly` `dev_delegate` call; a `contentOnly:true` run never provisions a worktree at all, so there is nowhere for the Developer to read the spec from. If a spec exists, distill it yourself into a short, plain-language description of what's needed — the item's purpose, its facets (app UI? background daemon? both?), main views/actions, what it persists — not a copy-paste of the whole spec.

Call `agent_delegate` with `agent:"developer"`, `contentOnly:true`. This is critical and easy to get subtly wrong: whether the harness treats the call as content-only or refuses it is decided by literally matching substrings in your `task` text (case-insensitive), not just the `contentOnly` flag.

- Your `task` MUST contain one of these phrases (verbatim or close to it): "standalone app", "self-contained index.html" (or "self contained index.html"), "write a bos app project", "staging directory" / "staging dir".
- Your `task` MUST NOT contain any of: "built-in app" / "built in app", "settings tab", "api route", "server logic", "bos source" / "browseros source" / "bos's own source" / "browseros's own source", "docs/dev/", or any path fragment matching `src/app/`, `src/apps/`, `src/components/`, `src/lib/`, `src/os/`, `src/store/`. This is a plain substring check — even a NEGATION like "this is not a built-in app" contains the trip-wire phrase "built-in app" and will get the delegation refused with "Refusing contentOnly developer harness run." Just don't say any of those words in the task text; describe the item in plain product terms instead.

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

**Project — an app, a service, or both, in one staging directory:**
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
   Do not build or install anything; just report the staging directory path.
   Item: <description>.")
```
Then call:
```
app_build({ name, dir: "<staging dir the Developer reported>", entry?, icon })
```
`entry` is relative to the app facet (`app/`) and defaults to `src/main.tsx`/`src/main.ts` if you omit it — i.e. it resolves `app/src/main.tsx`, not a bare top-level `src/main.tsx`. Omit it entirely for a services-only item (no `app/` facet at all) — `app_build` only resolves/bundles an entry when the item actually has an app facet.

## Step 2 — the install itself

Both `app_install` and `app_build` install the ITEM (not just an app facet):
- write the files into `data/user-apps/items/<id>/` at the paths given (`app/...`, and `services/...`/`config/...` if the staged item has those),
- commit that to the user's own `user-apps` GitFS repo,
- create/refresh the ONE `data/system/<id>` symlink (the actual "installed" state — 035-install-by-symlink), esbuild-bundling the app facet's entry if one is given,
- and — if the staged item has `services/service.json` — validate, register, and auto-start the service the same way a Marketplace-triggered service install does.

There is no separate `service_install` tool, and none is needed — `app_build` (and `app_install` for the plain-static-HTML-app case, though that shape can never include a service) are the one mechanism for every item shape.

**Where that commit lands depends on whether Build Studio itself is running on base or inside a preview** (this is per-process, unrelated to whether this conversation has an active BOS-source feature branch elsewhere):
- **The normal case — Build Studio running on base** (true for essentially every Build Studio session — its own chat surface always runs on base, even if this conversation separately has an active feature branch open for BOS-source work via `dev_delegate`): the install lands as a **draft on `user-apps`' own singleton `app-candidate` branch** (the older, base-only draft mechanism, unrelated to any `bos/<feature>` code branch). Tell the user it's a preview: the Topbar shows a separate "app preview" badge with its own **Promote app** / **Discard app** buttons — NOT the feature-branch Promote/Stop/Discard controls used for `target-bos-core.md`/`target-builtin-app.md`. You never promote or discard it yourself.
  - **This draft branch is a singleton — only one can be pending at a time.** If a previous marketplace-item draft hasn't been promoted/discarded yet, a new `app_install`/`app_build` call reuses the SAME `app-candidate` branch, bundling the new item's commit in with whatever is already pending — Promote/Discard then applies to both together. If the user is starting a genuinely separate item and an earlier one might still be pending, ask them to Promote or Discard it first (check the Topbar), rather than silently stacking drafts.
- **The rare case — the user is chatting with Build Studio from inside an actively-previewed `bos/<feature>` branch** (a different browser tab/instance pinned to that preview, itself running as a preview process, not base): `app_install`/`app_build` skip the `app-candidate` mechanism entirely and write straight into that preview's own `data/user-apps`, which is now correctly branch-coupled to `bos/<feature>` (mounted as its own git worktree, mirroring how spec stores are branch-coupled). The item then rides that SAME feature branch and is promoted/discarded together with the code via the ordinary feature-branch Promote/Stop/Discard controls — there is no separate "app preview" step in this case. You can't detect which case you're in via a tool; just read which control the Topbar actually shows and tell the user accordingly.

Use `app_list` to confirm the id/status afterward, and `bos_app_launch` to open an app facet for the user to review. For a service facet, point the user at Settings → Plugins → Services to manage it (start/stop/restart/logs/config) — installing does not require them to do anything further, but starting/inspecting it lives there.

## Choosing an id

The install namespace is flat and per-item: if `app_install`/`app_build` errors because the id already exists, that's an existing installed item (possibly the same one under active development) — ask the user whether they mean to update it (go to "Followups" below) rather than pick a different name and create a duplicate.

## Anti-pattern: don't have the Developer hand-write into `data/user-apps` instead

A BOS-source `dev_delegate` task (see `target-bos-core.md`) now runs in a worktree where `data/user-apps` (relative to the Developer's own cwd) is a real, writable, correctly branch-coupled path — a recent fix (`linkUserAppsIntoWorktree`) made this safe where it used to silently discard anything written there. That fixes a data-loss bug; it does NOT make hand-writing there a substitute for `app_install`/`app_build` — always have the Developer write to a FRESH staging directory (never the live item path directly) and finish with `app_install`/`app_build` yourself. Reasons this still matters even though `app_build` can install a full item: writing straight into the live path skips the draft/app-candidate sequencing (`app_build` needs to check out the app-candidate branch *before* the write it's about to make, not after one already happened), and a stray direct write left behind after a failed/aborted delegation can confuse the next install. Keep the two concerns (BOS-source work, marketplace-item work) as separate delegations with separate destinations, even within the same conversation.

Relatedly: don't reach for `src/` just because a service facet needs raw protocol/continuous-process behavior Next.js can't provide — see "Before you conclude a service facet needs BOS source" above. That mistake and this one share the same root cause (treating a marketplace-item limitation as if it forced a BOS-source workaround), just at different steps.

## Followups / bug reports on an already-installed marketplace item

Still no feature branch, still `contentOnly:true`. Relay the user's report immediately — do not read the item's files yourself to theorize first (you have no VFS mount there anyway). Two-step, mirroring the initial build:

1. `agent_delegate(agent:"developer", contentOnly:true, task: "...")` — tell the Developer it MAY read the current implementation in place at `data/user-apps/items/<id>/` (a real relative path in its working directory) to understand what exists, but it must WRITE the corrected version into a fresh staging directory (never edit those files in place) and report that directory. Describe the user's exact complaint. Keep the same phrasing rules as Step 1 (trigger phrases present, trip-wire phrases absent).
2. Call `app_build({ name, dir, icon })` again with the same item name/id — it overwrites the changed facet(s), re-bundles/re-activates as needed, and lands a new draft for the user to Promote/Discard (same base-vs-preview split as Step 2 above — usually the singleton `app-candidate` branch, via its own "Promote app"/"Discard app" controls).

Never patch `data/user-apps` files yourself, and never skip straight to `app_build` without the Developer round-trip — you have no way to produce corrected content yourself.

## Spec bookkeeping

`user-apps/marketplace.json` is maintained by BOS itself (reconciliation on install/create/uninstall) — you never hand-edit it. If the item has a spec, keep spec.md as the source of truth as usual, set its **App Target** field to `marketplace-item`, and note the install location (`data/user-apps/items/<id>/`) and which facets it has in it.
