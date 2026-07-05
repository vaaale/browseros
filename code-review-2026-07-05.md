# BrowserOS — Principal Engineering Code Review

**Date:** 2026-07-05
**Scope:** `src/**` (application code, API routes, libs) and `tools/**`. Docs, seed data, and build config excluded.
**Method:** Full read of every route handler and every module in `src/lib`, `src/os`, `src/store`, `src/apps`, `src/components`, plus `tools/`. Top findings spot-verified against source with line-level evidence.
**Design context:** BrowserOS is a deliberately powerful, local, single-user dev tool whose agent can execute bash/git and modify BOS itself. Findings flag issues only where they exceed that design intent, break correctness, or contradict the code's own stated invariants.

---

## Summary

The codebase is well-engineered for its stated design. The parts that are genuinely hard — SSR store seeding, CopilotKit action lifecycle, atomic file writes, path jailing, the Supervisor's promote-with-rollback flow, OAuth PKCE + token refresh dedup — are handled with real care and are correct as far as review could verify. The `server-only` boundary is respected consistently, and secrets at rest are encrypted (AES-256-GCM under a `0600` keyfile) with only non-sensitive projections reaching the client.

The weaknesses cluster into four themes:

1. **Safety invariants enforced by text, not mechanism.** The most important finding: the "content-only" agent harness runs an unrestricted autonomous Claude Code process (`--dangerously-skip-permissions`) inside the *live* BOS checkout, gated only by keyword matching on the task string. Similarly, the feature-branch consent gate reads state from the agent-writable VFS, and the legacy unsandboxed `bash -lc` host-exec route still exists despite config text claiming it was removed.

2. **No transport-level request authenticity.** There is no `middleware.ts` and no Origin/`Sec-Fetch-Site` check anywhere. The app relies entirely on "it's localhost," but browsers still deliver cross-origin no-preflight POSTs — so any web page the user has open can silently drive destructive endpoints (bash, VFS delete, app purge, delegation).

3. **Same-origin iframes retain full shell privileges.** Both the web-browsing proxy and installed (agent-authored) apps run in `allow-same-origin` sandboxes served from the BOS origin, so their JavaScript can read BOS cookies and call every `/api/**` route. The sandbox provides no isolation.

4. **In-memory / read-modify-write state treated as authoritative.** The scheduler and workflow log both do full-file read-modify-write under concurrency, losing updates; the integration scheduler can double-fire jobs and duplicate notifications, which feed straight into agent context.

Below, findings are grouped by severity. Each is cross-referenced to the subsystem it came from. Nothing here is a fire in a shipped product — but the Critical/High items undermine safety stories the code explicitly tells itself, and are worth closing before this tool is trusted with a repo that matters.

**Overall health:** Good. Strong foundations, disciplined boundaries, a handful of sharp edges where a documented guarantee doesn't actually hold.

**Top 5 priorities (across all subsystems):**

1. Move content-only harness runs out of the live checkout (C1).
2. Add a single `middleware.ts` enforcing same-origin on mutating `/api/**` (H1).
3. Remove `allow-same-origin` from the proxy iframe and isolate installed apps from the shell origin (H2, H3).
4. Resolve the `bash -lc` drift — delete the route or fix the config text (H4).
5. Serialize scheduler/workflow file writes and add per-message dedup + tick-overlap guards (H5, M-series).

---

## Critical

### C1 — Content-only agent harness runs an unrestricted autonomous agent inside the live BOS checkout, gated only by keyword matching

**Files:** `src/lib/agent/subagents/claude-runner.ts:40–61`, `src/lib/devharness/harness-config.ts:16,23–26`

The non-content-only path enforces the system's stated invariant — "BrowserOS source edits must never run in the live checkout" — by routing through the Supervisor's feature-branch worktree. The content-only path does not: it spawns `claude -p … --dangerously-skip-permissions` with `cwd = harness.cwd`, and `harness-config.ts:23` sets `const cwd = process.cwd()` — the live BOS repo. The only guard is string heuristics: `isBosSourceTask()` blacklists needles like `"settings tab"`, `"api route"`, `src/lib/…`, and a companion whitelist looks for `"staging directory"`. A task phrased to include a whitelist needle and avoid the blacklist runs a fully autonomous, permission-skipping coding agent directly in the live source tree — defeating the harness's own central safety invariant.

Verified: `claude-runner.ts:36` comment confirms `--dangerously-skip-permissions`; `harness-config.ts:14` comment states "users must not choose where BOS source edits land," yet content-only lands them in `process.cwd()`.

**Fix:** Run content-only tasks in a scratch/temp cwd (they never need the repo) rather than `process.cwd()`; keep the keyword heuristic only as a secondary defense.

---

## High

### H1 — Mutating API routes have no Origin/CSRF protection; reachable cross-origin via simple requests

**Files:** all mutating routes; notably `src/app/api/system/bash/route.ts:11`, `src/app/api/fs/route.ts:20`, `src/app/api/apps/route.ts:37` (`DELETE ?purge=1`), `src/app/api/subagents/delegate/route.ts:16`, `src/app/api/scheduler/route.ts:14`. No `middleware.ts` exists (verified absent) and no route checks `Origin`/`Sec-Fetch-Site`.

Handlers call `await req.json()`, which parses the body regardless of `Content-Type`. A malicious page the user has open can `fetch("http://localhost:3000/api/system/bash", {method:"POST", body: JSON.stringify({command:"…"}), headers:{"Content-Type":"text/plain"}})` — a CORS simple request that triggers no preflight and is not blocked. The attacker can't read the response, but the side effect fires: run bash (if enabled), delete VFS files, purge installed apps, spawn delegations, create scheduler tasks. Notably `src/app/api/web-search/route.ts:13–14` *does* reject non-JSON, showing the pattern was considered but not applied to the dangerous routes.

**Fix:** Add a shared `middleware.ts` enforcing same-origin (`Sec-Fetch-Site: same-origin` / `Origin` allowlist) for all mutating `/api/**` methods — one place, closes the whole class.

### H2 — Web-proxy iframe runs third-party content same-origin with `allow-same-origin`

**File:** `src/apps/browser/index.tsx:93` — `sandbox="allow-scripts allow-forms allow-popups allow-same-origin"` on an iframe whose `src` is the same-origin proxy (`/api/proxy/...`).

Because proxied documents are served from the BOS origin and the sandbox keeps `allow-same-origin`, arbitrary remote JS executes with the BOS origin: it can read BOS cookies/localStorage, call any `/api/**` route, and reach `window.parent`. The HTML rewrite in `proxy-rewrite.ts` is not a security boundary. (By contrast, `src/apps/html-viewer/index.tsx:32` correctly uses `sandbox="allow-scripts"` — safe.)

**Fix:** Drop `allow-same-origin` for the browser-proxy iframe; if same-origin behavior is required, serve proxied content from a distinct sandboxed origin.

### H3 — Installed (agent-authored) apps can script the parent shell

**File:** `src/components/apps/IframeApp.tsx:12` — installed apps load from `/apps/<id>/` (same BOS origin) with `allow-same-origin`. Same-origin + `allow-same-origin` means an installed app's iframe can access `window.parent.document`, BOS cookies, and every BOS API; the sandbox provides no isolation from the shell.

**Fix:** Serve installed apps from an isolated origin/subdomain (or gate their API access) rather than relying on a sandbox that still grants same-origin.

### H4 — Legacy unsandboxed `bash -lc` host-exec route still live despite config claiming it was removed

**Files:** `src/lib/system/bash.ts:50`, `src/app/api/system/bash/route.ts:11–34`, contradicted by `src/lib/config/registry.ts:256`.

`registry.ts:256` states the "legacy unsandboxed `bash -lc` tool has been removed; a sandboxed `run_command` … replaces it." But `POST /api/system/bash` still runs `bash -lc <command>` directly on the host with full `process.env` and an arbitrary caller-supplied `cwd` (`route.ts:30`), gated only by the `system-tools.enabled` toggle. Combined with H1, this is the highest-impact CSRF target. The code contradicts its own documented design intent.

**Fix:** Remove `bash.ts` and the route (as the config text asserts), or correct the config text to state the tool still exists.

### H5 — Gmail webhook signature verification is a no-op under the default configuration

**File:** `src/lib/integrations/services/gsuite/adapters/gmail-webhook.ts:59–62,96–99,169–177`

When `extras.audience`/`pushServiceAccount` are unset (the default — `onEnable` only requires `topicName`), `verifyGoogleToken` skips both the `aud` and service-account checks (`if (expected.audience && claims.aud !== …)`), accepting *any* valid Google-issued ID token. Since a Pub/Sub push endpoint must be publicly reachable, any attacker with any Google account can mint a passing token and inject forged `gmail_history` notifications — which the assistant later reads as context (a prompt-injection vector).

**Fix:** Refuse to enable the Gmail webhook unless `audience` (ideally also `pushServiceAccount`) is configured, and fail `verify` when they're absent.

---

## Medium

### M1 — Feature-branch consent gate is bypassable (state lives in agent-writable VFS)

**Files:** `src/lib/agent/conversations-server.ts:28–42`; write path `src/components/agent/OSActions.tsx:153–169`
`getConversationActiveFeatureBranch` reads `activeFeatureBranch` from `/Documents/Chats/<id>.json` — the same VFS the model can write via `file_write`. The model can write the field itself and skip the `dev_branch_request` user-confirmation card that CORE_POLICY presents as mandatory. **Fix:** persist branch selection under `data/` behind a server API, or verify the branch exists via the feature-branches store before honoring it.

### M2 — Scheduler jobs can double-fire on overlapping ticks (duplicate notifications)

**Files:** `src/lib/integrations/scheduler/daemon.ts:45–54,82–88`; `jobs.ts:115–117`
Eligibility uses only in-memory `lastAttemptAt`, set when a run *starts*. Ticks aren't guarded against a still-running tick, and `POST /api/integrations/scheduler` triggers `tick()` concurrently with the daemon; two overlapping `collectRunnableJobs` calls both collect a not-yet-started job → it runs twice with the same `since` → duplicate `new_email` events (no dedup). Memory-only state also means every restart/hot-reload fires all jobs immediately. **Fix:** add a `tickInProgress` guard and/or claim `lastAttemptAt` inside `collectRunnableJobs`.

### M3 — Scheduler `tasks.json` writes lose updates under concurrent ticks

**File:** `src/lib/scheduler/storage.ts:34–46,138–178`
Every mutation reads the whole `tasks.json`, mutates in memory, and `writeAllTasks` overwrites it. `daemon.ts:63` runs due tasks with `Promise.all`; two tasks completing in one tick each read the same array and write back, so the second clobbers the first's `lastExecutedAt`/`nextRunAt`. Writes are atomic (no corruption) but updates are lost. **Fix:** serialize task-file writes through a single async queue, or use per-task files.

### M4 — Webhook delivery marked processed before the handler runs; failures dropped

**File:** `src/app/api/integrations/webhooks/[integrationId]/[serviceId]/route.ts:87–101`
`markDelivery(digest)` records the idempotency hash first; if `handler.receive` then throws, the provider's retry hits the dedup check and is acked with zero events. One transient error = permanently lost event. **Fix:** record the hash only after `receive` succeeds (or un-mark on failure).

### M5 — `enableWebhook` persists `enabled: true` before `onEnable`, and leaves it enabled on failure

**File:** `src/lib/integrations/webhooks/manager.ts:57–69`
Config is written `enabled: true` first; if `onEnable` throws (missing `topicName`, `users.watch` failure), the route 500s but state stays enabled while no provider subscription exists. **Fix:** flip `enabled` only after `onEnable` succeeds, or revert in a catch.

### M6 — Poll windowing can duplicate or miss messages at the boundary second

**Files:** `src/lib/integrations/services/gsuite/adapters/gmail.ts:373–375`; `scheduler/jobs.ts:147–166`
`since` is floored to seconds and the next cursor is the poll *start* time, with no per-message idempotency downstream; boundary-second messages get re-fetched or skipped. **Fix:** dedupe by Gmail message id (or use `historyId` cursors) instead of a wall-clock window.

### M7 — Per-agent action gating never applies to integration actions; `available` mutates after registration

**Files:** `src/components/agent/gated-action.ts:38–43`; `IntegrationActions.tsx:82–90`
The gate only fires when `available === undefined`, but Gmail actions always set `available: scopeGranted ? "enabled" : "disabled"`, so `gsuite_*` ids can never be disabled by an agent allowlist. `scopeGranted` is async, so `available` flips at runtime — violating the project's own documented rule that a CopilotKit action's `available` must not change after registration (`CopilotProvider.tsx:50–52`). **Fix:** combine the scope check with `isActionAllowed(name)` and mount only after scopes load.

### M8 — Prompts and descriptions reference renamed tools that no longer exist

**Files:** `src/lib/agent/instructions.ts:49`; `McpActions.tsx:30,63,77`; `ConfigActions.tsx:55`; `OSActions.tsx:29`; `claude-runner.ts:376`; `delegate/route.ts:66`
The snake_case tool rename left stale camelCase names (`searchMcpTools`, `getMcpToolSchema`, `listConfigurableSettings`, `listApps`, `requestFeatureBranch`) in the composed system prompt and several action descriptions. Models will attempt nonexistent tools. **Fix:** sweep all prompt/description strings against registered action names; ideally add a lint/test cross-referencing `CAPABILITIES` ids.

### M9 — Legacy conversations (no `agentId`) run with no system prompt at all

**Files:** `src/components/agent/AssistantChat.tsx:55–56`; `CopilotProvider.tsx:46–48`; `src/app/api/copilotkit/route.ts:58–76`
A pre-upgrade conversation without `agentId` resolves `agentId = undefined`, so the copilotkit route never builds the prompt-bearing `BuiltInAgent` — no CORE_POLICY, no memory, no skills. This also makes the `instructions` plumbing in `AssistantChatInner` dead code. **Fix:** fall back to `DEFAULT_AGENT_ID` when a conversation has no agent; delete the dead instructions plumbing.

### M10 — Capability registry is not the single source of truth it claims (scheduler tools invisible)

**Files:** `src/lib/agent/capabilities-registry.ts:1`; `subagents/tools.ts:99–103,212–215`
`SCHEDULER_TOOLS` are spread into every sub-agent's toolkit but absent from `CAPABILITIES`, so the tool-manifest, InfoPanel, and Settings picker can't show/grant them; any agent given a non-empty allowlist silently loses all scheduler tools with no UI path to restore. **Fix:** add them to `CAPABILITIES` as `context: "tool"` entries.

### M11 — Memory deletion keyed on a 60-char truncated substring

**Files:** `src/apps/memory/index.tsx:116` (`onRemove(e.slice(0, 60))`); `src/app/api/memory/route.ts:38–43`; `curated.ts:115` (`includes` match)
Deleting an entry sends only its first 60 chars, matched by substring server-side; two entries sharing a prefix (or one being a substring of another) delete the wrong or an extra entry. **Fix:** pass the full entry text or a stable id/index.

---

## Low

### L1 — `agent_delegate` leaves the delegation card spinning forever on a stream error
`src/components/agent/SubAgentActions.tsx:243` — the `error` branch returns without `finishDelegation(...)`, unlike the `!res.ok` and catch paths, so the card stays `done:false`. **Fix:** call `finishDelegation` before returning.

### L2 — Delegation live-event store keyed by raw task text
`src/lib/agent/subagent-events.ts:18`; `SubAgentActions.tsx:211` — two delegations with identical task text share one key; the second wipes the first. **Fix:** key by a generated id passed through the encoded result.

### L3 — `buildFrontmatter` performs no escaping — model text can corrupt/inject frontmatter
`src/lib/agent/subagents/markdown.ts:39–47` — values written raw; a description containing a newline breaks the file or injects keys (`x\npinned: true`). Reached by `skill_save`, `saveSkill`, `createSubAgent`. **Fix:** strip/escape newlines and leading `[`/quotes.

### L4 — `createSubAgent` spread-order bug and silent overwrite by slug
`src/lib/agent/subagents/store.ts:214` — `{ id, type: input.type ?? "local", ...input }` lets the trailing spread overwrite `type`; also no id-collision check, so `agent_create` "Developer" silently replaces the seeded agent. **Fix:** spread first then apply defaults; refuse/suffix on seed-id collision.

### L5 — Workflow execution log is a full read-append-rewrite, racing concurrent steps
`src/lib/workflows/store.ts:91–96` — concurrent step events both read the pre-append array; the second rewrite drops the first event. **Fix:** serialize appends per workflow id, or append NDJSON lines.

### L6 — Skill id not path-jailed (traversal via skill name)
`src/lib/agent/skills/store.ts:291–308,362–371` — `readSkillFile` jails `relPath`, but the skill *id* is joined unsanitized (`path.join(DIR, id)`); an id like `../../x` escapes, and `removeSkill` `fs.rm`s it recursively. **Fix:** validate ids against `/^[a-z0-9-]+$/` (they're slugified on write anyway).

### L7 — OAuth `startFlow` accepts arbitrary scopes beyond the manifest
`src/lib/integrations/oauth/manager.ts:90` — requested `scopes` come from a query param with no validation against `supportedScopes`, so a caller can request Drive/Contacts scopes and get usable tokens. **Fix:** reject scopes not in `manifest.oauthConfig.supportedScopes`.

### L8 — HMAC webhook secret machinery is dead for the only registered handler
`src/lib/integrations/webhooks/verify.ts:26–62`; `manager.ts:89–96`; `gmail-webhook.ts:163–177` — the UI mints/rotates a secret, but `GmailWebhookHandler.verify` ignores it; "Rotate secret" protects nothing. **Fix:** only mint/show secrets for handlers declaring the HMAC scheme.

### L9 — `secrets.json` briefly created world-readable before chmod
`src/lib/integrations/secrets/store.ts:82–86`; `src/os/atomic-write.ts:14–21` — temp file opened at default `0644`, renamed, then best-effort `chmod 0600`. Content is ciphertext so exposure is limited. **Fix:** let `writeFileAtomic` accept a `mode` and open the temp file `0o600` for secrets.

### L10 — Client `spec_edit` / `spec_search` diverge from the server implementations
`src/components/agent/SpecActions.tsx:75–103` vs `subagents/tools.ts:166–183` — client `spec_edit` is a non-atomic read-modify-write reimplementing `specfs.editFile`, and client `spec_search` matches paths while the server greps content; same id, different behavior per surface. **Fix:** route client actions through `/api/specs`.

### L11 — `run-command`-less agents told to use `run_command`; other prompt/tool mismatches
`src/lib/agent/subagents/tools.ts:77–88` tells agents to "run scripts with run_command," but the runner injects it only when explicitly allowlisted (`runner.ts:100–102`). **Fix:** align the description with actual tool provisioning.

### L12 — Failed one-time scheduler task becomes a stuck `active` task
`src/lib/scheduler/storage.ts:155,165–173` — one-time tasks are marked `completed` only on success; on failure `calculateNextRun` returns `null`, leaving an `active` task with `nextRunAt: null` that never re-runs or gets deleted. **Fix:** decide explicitly whether a failed one-time task is completed/deleted.

### L13 — Maximized window ignores store-computed coordinates
`src/store/os-store.ts:130–137` writes `x/y` on maximize, but `src/components/desktop/Window.tsx:130–131` renders from a hardcoded inset and never reads them — dead writes, latent inconsistency. **Fix:** drop the x/y writes or derive the maximized style from them.

### L14 — Token-refresh race with a stale `current` snapshot
`src/lib/integrations/oauth/manager.ts:198–206` — `refreshToken(id, current)` uses a token captured before the in-flight check; under refresh-token rotation a second caller reuses the old refresh token. Harmless with Google's non-rotating tokens. **Fix:** re-read tokens inside the in-flight closure.

### L15 — Errors silently swallowed across scheduler/webhook paths (no logging)
`src/lib/integrations/scheduler/daemon.ts:76–87`; `jobs.ts:220`; webhook route `66–69` — `catch { return; }` / `.catch(() => {})` throughout; a crashed tick is indistinguishable from silence. **Fix:** add a minimal namespaced logger for swallowed exceptions.

---

## Info / Housekeeping

- **SSRF guard is name-only** (`src/lib/net.ts:4–11`, `proxy/[[...path]]/route.ts:40,52`): `isBlockedHost` checks the initial hostname but `fetch(..., { redirect: "follow" })` follows redirects without re-checking, and DNS rebinding passes. Acceptable for a local tool but worth `redirect: "manual"` + per-hop revalidation. (I1)
- **Duplicated path-jail resolve logic** across `vfs.ts:28`, `spec-fs.ts:35,135`, `repo-fs.ts:44`, `docs/store.ts:104`, `apps/build.ts:75` — all correct, but a shared `resolveUnder(root, rel)` helper would prevent a future miscopy. (I2)
- **Duplicated JSON-store read/write pattern** across `config/store.ts`, `mcp/store.ts`, `scheduler/storage.ts`, `apps/store.ts` — extract a typed `jsonStore(path)` helper. (I3)
- **Three hand-rolled mutex implementations** (`secrets/store.ts:34`, `state/store.ts:22`, `notifications/store.ts:46`) — consolidate into one. (I4)
- **Duplicated integration error→HTTP-status ladder** (`invoke/route.ts:82–118` and `poll/route.ts:115–142`, byte-identical) — extract `integrationErrorResponse(err)`. (I5)
- **Duplicated web-search formatting** (`WebSearchActions.tsx:24–33` vs `web-search.ts:106–117`) — two formats that will drift. (I6)
- **Small duplicated UI helpers** (`short()`, two `formatRelative()`, `humanize()`) — candidate for a shared `lib/format`. (I7)
- **Dead code:** `removeSubAgent` (`subagents/store.ts:220–223`, no callers; bypasses `ProtectedAgentError`). (I8)
- **`ensureSeed` sets `seeded = true` before awaiting writes** (`skills/store.ts:186`, `subagents/store.ts:144`) — a failed first seed isn't retried until restart; a concurrent first call can observe a half-seeded dir. (I9)
- **Skill usage telemetry has no write lock** (`skills/usage.ts:31–39`) — concurrent `touchSkill`s lose counts. (I10)
- **`apps/build` reads an arbitrary host dir with no path jail** (`apps/build.ts:27`, `path.resolve(body.dir)`) — combined with H1, cross-origin readable-file exfiltration into an installed app. Confine to a staging root. (I11)
- **`GET /api/mcp/tools` has no error handling** (`mcp/tools/route.ts:12–20`) — unlike POST; a throwing stdio server yields a bare 500. (I12)
- **`AppearanceTab`/`Files` wallpaper writes are fire-and-forget** (`AppearanceTab.tsx:15`, `files/index.tsx:134`) — a failed server write diverges client/server silently. (I13)

---

## What is done well (worth preserving)

- **Store & SSR:** `os-store.ts` is a clean vanilla Zustand store with pure immutable updates; `os-provider.tsx` uses the canonical seed-once pattern — no hydration bugs found.
- **Path jailing** is correct everywhere it appears (lexical `root + sep` prefix check), and the installed-app route guards path escape correctly.
- **Atomic writes** (`atomic-write.ts`: temp → fsync → rename) are used pervasively and underpin the hardlink data-isolation scheme.
- **OAuth** uses PKCE S256 with random, single-use, 10-minute-TTL state (real CSRF protection on the OAuth leg), in-flight refresh dedup, and correct `invalid_grant` handling.
- **Secrets** are AES-256-GCM under a `0600` keyfile; only a non-sensitive metadata projection reaches state/client; no secrets are logged anywhere.
- **Memory (`curated.ts`)** is exemplary: per-target write locks, atomic temp-file renames, budget enforcement, injection scanning.
- **The Supervisor** (`tools/supervisor`) is careful: `assertRepoIntegrity` gate, process-group kills, off-port health-gating before the promote point-of-no-return, single-writer serialized log store.
- **Command execution** uses `execFile`/argv arrays (no shell interpolation) except the intentionally-gated legacy bash tool; git helpers reject `..`/leading-`-` paths and use `--` separators.
- **The workflow DAG runner** is a correct Kahn-style scheduler with concurrency caps, abort handling, and cycle detection.
