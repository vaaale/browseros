# BrowserOS — Principal Engineer Code Review

**Date:** 2026-07-05
**Scope:** Full `src/` tree (296 files, ~28,200 LOC) + `tools/gen-apps.mjs`, reviewed across five parallel domain passes (core/state/desktop, API routes, agent subsystem, apps, infrastructure libs) plus mechanical checks (duplication scan, dependency/test audit). Read-only review; no code was modified.

---

## Executive summary

BrowserOS is a well-architected codebase for its ambition. The low-level primitives are genuinely good: `atomic-write.ts` is a correct temp→fsync→rename; git is shelled out exclusively via `execFile` with argv arrays (no shell injection); the per-request Zustand store correctly avoids the SSR shared-store trap; the capability registry has successfully eliminated action/tool-manifest drift (verified zero drift on the 70 main-chat tools); server-only boundaries are respected (`import "server-only"` on the sensitive modules, framework-free `types.ts`, all client I/O over `fetch`); and the integrations security stack (AES-256-GCM secrets, per-secret IV, timing-safe webhook verification, mutexed writes) is the best-engineered corner of the system.

The problems are concentrated at **two seams**, and they are consistent across independent reviewers:

1. **The trust boundary for self-modification and untrusted apps is porous.** BrowserOS runs user-installed apps in same-origin iframes and lets its own agent rewrite the system, but the app install/build/purge paths perform client-controlled filesystem operations *without* the path-jailing the rest of the codebase applies correctly elsewhere. This yields two remotely-reachable arbitrary-write / arbitrary-delete primitives (Critical), an arbitrary host-file read (High), a string-only SSRF filter (High), and an agent path to unsandboxed host command execution (High). The knowledge to fix these already exists in the repo — the safe idiom is simply omitted in these specific spots.

2. **Copy-paste plumbing instead of shared helpers.** The absence of three small utilities — a `fetch` wrapper, a jailed-path resolver, and a JSON-file read/write-with-lock — has let divergent, buggy patterns proliferate: ~48 unguarded `fetch().then(r=>r.json())` handlers in the agent layer and ~32 in the apps layer (unhandled rejections, false "Saved" toasts, stuck spinners), six hand-rolled path jails (the two that were forgotten are the Criticals), seven JSON readers with incompatible error semantics, and unlocked read-modify-write on shared JSON state files (scheduler, workflows) that silently loses data under the concurrency the code itself creates.

Neither seam is architecturally rotten. The design is sound; the execution is inconsistently disciplined. Fixing the ~8 security findings and introducing the three shared helpers would resolve the majority of everything below — several items at *negative* net line count.

Note on the mechanical duplication scan: `jscpd` reported only 159 exact-clone lines (0.56%). This under-counts the real duplication because the significant repetition here is *structural/idiomatic* (same shape, different identifiers), which token-based clone detection misses. The per-domain findings below quantify it directly.

### Findings by severity

| Severity | Count | Theme |
|---|---|---|
| Critical | 2 | Unjailed client-controlled FS write & delete |
| High | 6 | SSRF, arbitrary file read, agent host-exec, secret leakage, unlocked concurrent state, dev-agent secret access |
| Medium | ~18 | Duplication, error-contract inconsistency, missing error handling, oversized modules, mislabeled/dead security toggles |
| Low | ~15 | Dead code, magic constants, type-assertion noise, minor UX/a11y |

### Top 8 remediation priorities (Impact + Risk × ease)

1. **C1/C2** Jail `installApp` file keys and `purgeApp`/`readApp` ids — one-line guards, stops arbitrary write/delete.
2. **H2** Resolve-and-validate DNS in the SSRF filter — closes proxy/`web_fetch` to internal/metadata endpoints.
3. **H3** Restrict agent `mcp_server_add` to http/sse (or gate stdio behind consent) — closes unsandboxed host exec.
4. **H1** Jail `readProjectDir` dir under a staging root — stops arbitrary host-file read.
5. **H5** Redact MCP configs before returning them to the model/transcripts — stops secret leakage.
6. **H4/H6** Sandbox `contentOnly` agent runs; fence `data/` out of the dev-agent's read/write allowlist.
7. **M-shared** Introduce `callBosApi()` / `apiFetch()` and adopt it across `*Actions.tsx` and settings tabs — kills ~80 unguarded fetches and most correctness bugs.
8. **M-shared** Introduce `lib/fsutil` (`resolveUnder`, `readJsonSafe`, `withLock`) and merge `spec-fs`/`repo-fs` — removes the duplication root cause.

---

## Category 1 — Architecture debt

**Client/server-controlled filesystem operations that skip the shared jail (root cause of C1/C2/H1).** The codebase has a correct path-jail idiom — `abs !== root && !abs.startsWith(root + path.sep)` — hand-rolled in six places (`os/vfs.ts:32`, `dev/spec-fs.ts:41,138`, `dev/repo-fs.ts:47`, `docs/store.ts:108`, `apps/build.ts:75`). The two write paths that *omit* it (`apps/store.ts` install and purge) are exactly the Critical findings. A single shared `resolveUnder(root, rel)` would make the safe path the only path.

**Bidirectional module dependency `dev/` ↔ `specs/`.** `src/lib/dev/spec-fs.ts:5-7` imports `@/lib/specs/{stores,store-git,seed}`, while `src/lib/specs/pipeline.ts:2` imports back from `@/lib/dev/spec-fs`. `spec-fs` is spec-store code living in the wrong directory; move it to `lib/specs/fs.ts`. Compounding naming hazard: `lib/system/run-command.ts` (sandboxed exec) and `lib/dev/run-command.ts` (allowlisted build commands) are unrelated concepts sharing a filename.

**No shared HTTP/data-access layer.** Every app and every agent action hits the same `/api/*` surface, but there is no `apiFetch` wrapper and no query hook. This single omission is the direct cause of most Medium correctness findings in the agent and apps layers (below). Three divergent error-handling styles now coexist: proper `res.ok` + typed error, bare `.then(r=>r.json())`, and `.catch(()=>{})` swallow.

**Ad hoc client-server state.** `useIntegrations` (`integrations/useIntegrations.ts:97-131`) spins up an independent fetch+state instance per consumer, so its own "one shared hook" contract only holds inside `IntegrationsTab` (via prop-drilling); other consumers get stale, duplicated snapshots. `/api/assistant/agent` is independently fetched in six places, each with its own refresh semantics. This is state that belongs in the Zustand store or a shared cache.

**`config/registry.ts` is a 360-line chokepoint.** Fourteen config namespaces (schema + load + save) inline in one file that every feature must edit. Split registrations per feature.

---

## Category 2 — Security debt

### Critical

**C1 — Arbitrary file overwrite via unjailed install file-map keys.** `src/lib/apps/store.ts:169-171`: `for (const [rel, content] of Object.entries(input.files)) await writeFileAtomic(path.join(dir, rel), content)`. `input.files` comes verbatim from the `POST /api/apps` (and `/api/apps/build`) body; keys are never validated. A key like `"../../../src/lib/agent/config.ts"` or `"../../config/ai-provider.json"` writes outside the app directory — into BOS source, runtime config, or secrets-adjacent state. Reachable same-origin from any installed app. **Fix:** per-key `const abs = path.resolve(dir, rel); if (abs !== dir && !abs.startsWith(dir + path.sep)) throw`; reject absolute keys. (`buildAppDir` at `build.ts:74-77` already does exactly this — apply it here.)

**C2 — Arbitrary recursive directory deletion via unjailed app id.** `src/lib/apps/store.ts:213-214`: `fs.rm(path.join(root(), id), { recursive: true, force: true })` where `id` is the raw `?id=` query param (`api/apps/route.ts:39-42`), no validation. `DELETE /api/apps?purge=1&id=../vfs` deletes the user VFS; `id=../..` deletes the BOS checkout. The store only ever *generates* slug ids, so the fix is one guard: reject any id not matching `/^[a-z0-9][a-z0-9-]*$/` at the top of `readApp`/`purgeApp`.

### High

**H1 — Arbitrary host-file read exposed as a servable app.** `src/lib/apps/build.ts:26` (`readProjectDir`, reached by `POST /api/apps/build`) does `path.resolve(dir)` on a client-supplied absolute path with no jail, walks it, and slurps every text file (≤4 MB) into an installed app served at `/apps/<id>/`. `{ "dir": "/home/user/.ssh" }` becomes an exfiltration path. **Fix:** require `dir` under a known staging root and jail it.

**H2 — SSRF filter is string-only and trivially bypassable.** `src/lib/net.ts:4-11` (used by `GET /api/proxy/**` and the agent's `web_fetch`) pattern-matches the literal hostname and never resolves DNS. Verified bypass classes: numeric IP encodings (`http://2130706433/`, `0x7f000001`, `0177.0.0.1` all = 127.0.0.1); IPv6 loopback/private forms beyond the single blocked `::1` (`[::ffff:127.0.0.1]`, `[fd00::1]`, `[fe80::1]`); and any public hostname whose DNS points at a private/metadata IP (cloud metadata `169.254.169.254` via DNS rebinding). **Fix:** resolve the hostname, validate every resolved address against private/loopback/link-local/ULA ranges, normalize numeric encodings, and pin the connection to the validated IP.

**H3 — Agent `mcp_server_add` grants unsandboxed host command execution with no consent.** `src/components/agent/McpActions.tsx:105-128` exposes `command`/`args`/`env` to the model; `/api/mcp` → `connectMcpClient` (`lib/mcp/client.ts:36-54`) then `new StdioClientTransport({ command, args, cwd: cfg.cwd || process.cwd(), env })` spawns whatever the model configured, in repo root, on the next gateway call. This bypasses the `run_command` sandbox entirely (which is off-by-default and flagged dangerous); `mcp_server_add` is not in `DANGEROUS_TOOL_NAMES`. **Fix:** restrict the agent-facing action to `http`/`sse` transports (stdio only via the Settings UI), or gate stdio behind a `renderAndWaitForResponse` consent card; add it to the dangerous list regardless.

**H4 — `contentOnly` Claude runs use `--dangerously-skip-permissions` in the live checkout, guarded only by keyword heuristics.** `src/lib/agent/subagents/claude-runner.ts:74-80` always passes `--dangerously-skip-permissions`. The non-contentOnly path is well-defended (worktree + feature branch + Supervisor). The `contentOnly` path (lines 334-350) runs in the repo cwd with no worktree/branch/Supervisor; its only guard is substring matching (`isStandaloneContentTask`/`isBosSourceTask`, lines 22-56). A task worded to include a whitelist needle and avoid blacklist needles — producible by the model or by prompt-injected relayed content — gets a fully-permissioned agent on the live checkout. **Fix:** run `contentOnly` tasks in a fresh temp dir; treat the keyword check as advisory logging, not the boundary.

**H5 — MCP server secrets returned into model context and persisted transcripts.** `GET /api/mcp` returns raw configs including `apiKey`/`headers`/stdio `env` (`api/mcp/route.ts:53`); `mcp_server_list` and `mcp_server_add` stringify them into tool results (`McpActions.tsx:21-24,126`), so tokens flow into the LLM prompt and into on-disk chat files. Contrast `provider.ts`, which has a deliberate secret-free `getProviderConfigView`. **Fix:** add an equivalent redacted MCP view and use it for the GET route and both action results.

**H6 — Dev-agent fence doesn't cover `data/`; secrets readable and writable.** `src/lib/dev/repo-fs.ts:15-27`: `READ_DENY` blocks `.git`/`node_modules`/`.next`/`.env*` but not `data/`, and `WRITE_ALLOW_PREFIXES` explicitly includes `"data/"`. So the developer sub-agent can read `data/.integrations-key` + `data/integrations/secrets.json` (key + ciphertext = plaintext OAuth tokens) and overwrite the keyfile, config, agents, and skills. **Fix:** add `/(^|\/)data(\/|$)/` to `READ_DENY`; drop `"data/"` from the write allowlist.

### Medium (security)

**Two overlapping exec surfaces; one gated, one not, and mislabeled.** `src/lib/system/bash.ts` still spawns `bash -lc <cmd>` on the host with full `process.env`, gated by `system-tools.enabled` — but that toggle's own description says the unsandboxed tool "has been removed." The sandboxed `run_command` reads a *different* namespace (`run-command.enabled`). A user enabling the toggle they were told is safe arms the removed tool. **Fix:** delete `lib/system/bash.ts` + route (no other importers), or correct the description and env-strip the child. Related: all local exec backends (`run-command.ts:130`, `bash.ts:50`, `dev/run-command.ts:39`) spawn with `env: process.env`, leaking every server secret to agent-authored commands — pass a minimal allowlist.

**Internal error messages leaked verbatim.** ~all catch blocks return `(err as Error).message` to the client (`git/route.ts:19,51`, `apps/build/route.ts:40`, `fs/route.ts:16`), exposing absolute host paths and git/fs internals — reconnaissance for the same-origin attacker. Log server-side, return generic messages for 5xx.

**Per-agent action gating is client-side only.** `gated-action.ts:44-50` disables disallowed actions in the browser, but the API routes they call (`/api/config`, `/api/specs`, `/api/skills`, `/api/apps`, `/api/memory`, `/api/workflows`) never re-check the allowlist — even though the MCP gateway and integrations dispatcher explicitly do ("the client flag is presentation, not authorization"). For a system whose premise is a self-rewriting agent, enforce `resolveActionGate` server-side on the sensitive groups.

---

## Category 3 — Concurrency & data-integrity debt

**H (data loss) — Unlocked read-modify-write on shared JSON state.** `scheduler/storage.ts` does `listTasks() → mutate → writeAllTasks()` with no lock, while `daemon.ts:63` runs due tasks via `Promise.all` and each completion rewrites the whole file from its own stale snapshot — so simultaneous completions silently revert each other's `nextRunAt`/`lastExecutedAt`, causing re-execution or lost tasks. Same pattern in `workflows/store.ts:91-96` (append from up to 5 parallel steps, fire-and-forget `.catch(()=>{})`). Ironically `integrations/` contains three working mutexes. **Fix:** a module-level promise-chain mutex around the RMW (copy `integrations/state/store.ts:22-36`); use append-only JSONL for logs.

**Spec-store promote can strand the repo mid-merge.** `specs/store-git.ts:73-81` runs `git merge --no-edit spec-candidate` with no conflict handling and no `merge --abort`; on conflict the store is left in a conflicted state and the next `commitAll` — which ends in `.catch(()=>{})` (`gitfs/store.ts:52,61`) — silently commits conflict markers. The same swallow hides genuine commit failures, making "versioned" content quietly unversioned.

**Concurrent spec writes race a live `git checkout`.** `dev/spec-fs.ts:98-112` + `store-git.ts:58-64`: each write to a `requiresPromote` store does checkout → write → commit with no serialization; two Build Studio writes can interleave onto the wrong branch. **Fix:** per-store mutex around prepare→write→commit.

**`readNamespace` swallows all errors → settings wiped on next patch.** `config/store.ts:10-16`: `catch { return {}; }` treats a parse error or transient `EPERM/EMFILE` as "file missing"; `patchNamespace` then persists `{...{}, ...patch}`, discarding every other key (e.g. the stored provider key when toggling one boolean). `scheduler/storage.ts:24-32` shows the correct ENOENT-only pattern.

**VFS cold-start seed race.** `os/vfs.ts:59-78` sets `seeded = true` *before* creating `Documents/Pictures/Desktop`; a concurrent first request returns early and then `list("/Documents")` 500s on ENOENT. **Fix:** store the in-flight promise, not a boolean. (Also `list()` uses `Promise.all(...stat)` which fails the whole listing if one child is concurrently deleted — use `allSettled`.)

**Draft app installs land live when the Supervisor is unreachable.** `apps/store.ts:163-165` awaits `supervisorAppBegin()` but `call()` returns `null` on any error and the result is unchecked; a briefly-unreachable Supervisor commits a requested *draft* straight to the live branch. **Fix:** throw when `draft` was requested and the begin call failed.

---

## Category 4 — Code / duplication debt

**~80 unguarded `fetch().then(r=>r.json())` handlers, no shared helper.** Agent layer: ~48 across `*Actions.tsx` (McpActions 8, WorkflowActions 7, SpecActions 6, DevActions 5, …); only `OSActions` file handlers try/catch. Apps layer: ~32 across 13 files. A network failure or non-JSON response throws raw out of the handler instead of the codebase's own `` `Error: ${…}` `` contract, or gets swallowed by `.catch(()=>{})` (e.g. `docs/index.tsx:56` shows "No documents" on a network error; `chat/index.tsx:23` hides the missing-API-key banner exactly when connectivity breaks). `integrations/actions/dispatcher.ts:114-145` is the existing right pattern. **Fix:** one `callBosApi(url, init)` helper.

**Duplicated FS/git plumbing (quantified).** `repo-fs.ts` vs `spec-fs.ts` share ~120 of 211 lines (identical sort comparator, 512 KB read truncation, unique-occurrence `editFile`, a byte-for-byte ~45-line `search` walker). The git exec helper (`gitfs/store.ts:17-29`) is duplicated verbatim in `specs/store-git.ts:12-23`; the `.git`-presence check appears 3×; the spawn/collect/truncate/kill body is ~80 near-identical lines across `run-command.ts` and `bash.ts`; `slugify` has 3 copies; `readJson`-with-fallback has 7 implementations with two incompatible error semantics; there are two structurally identical polling daemons (`scheduler/daemon.ts`, `integrations/scheduler/daemon.ts`).

**Duplicated UI scaffolding.** NDJSON stream-reader duplicated 4× (`SubAgentActions.tsx:226-245` ≈ `WorkflowActions.tsx:77-97` client; `claude-runner.ts` `runClaudeCli`/`runOpenCodeCli` ~60 lines each server). Modal shell duplicated 3× with behavioral drift (scheduler's closes on Escape/backdrop; `NewAgentDialog` neither). `SkillsGrid.tsx` and `McpGrid.tsx` are ~95% identical. The input class string appears 19× across 8 files; three private `Field` components exist. The config-namespace read is copy-pasted across `LogsTab`/`DevHarnessTab`/`DataFsTab` (wants a `useConfigNamespace(ns)` hook). `formatRelative` implemented twice with different signatures.

**Wallpaper "update store + persist" dual-write hand-rolled 3×** (`AppearanceTab.tsx:15`, `OSActions.tsx:68`, `files/index.tsx:134`), one fire-and-forget with no rollback — UI shows new wallpaper, server keeps old, next SSR reverts it silently.

---

## Category 5 — Correctness & error-handling debt (non-security)

**MCP server rename deletes the old config before saving the new one.** `McpServersTab.tsx:196-206`: DELETE-then-POST; if the POST fails, the original config (incl. API key) is already gone and the DELETE result isn't even checked. **Fix:** atomic rename server-side via `previousName` (as `/api/skills` already does with `previousId`), or POST-then-DELETE-on-success.

**Widespread `try { fetch } finally {}` with no `catch`** → unhandled rejections and false confirmations: `SkillsTab`, `ProviderSettings`, `VersionsTab`, `AppsTab`, `McpServersTab` (probe stays spinning forever on throw). `LogsTab.tsx:131` and `DataFsTab.tsx:46` print "Saved" without checking `res.ok`. `DataFsTab.load` / `settings/index.tsx:37` / `memory/index.tsx:12` get stuck on "Loading…" forever on error. Scheduler mutations (`scheduler/index.tsx:140-158`) ignore failures; `openDetail` keeps the previous task's history when a fetch fails, showing the wrong task's execution history.

**`agent_delegate` error path leaves the delegation card spinning forever.** `SubAgentActions.tsx:243` returns on `error` without `finishDelegation`, so the card stays `done:false`. The delegation store is also keyed by task text (`String(task ?? "")`), so identical task text collides. **Fix:** `finishDelegation` in `finally`; key by a generated id.

**Memory delete silently fails for prefix collisions.** `memory/index.tsx:116` sends a 60-char prefix; the server rejects ambiguous matches with `{success:false}` but the client ignores it, so two entries sharing a 60-char prefix can never be deleted via the button. Send the full text.

**Maximize geometry contradicts between store and renderer.** `os-store.ts:130-137` writes `x:MARGIN(24)`/`y:TOPBAR_H+8` on maximize but `Window.tsx:130` renders a fixed `{top, left:8, right:8, bottom:84}` and never reads `win.x/y` in that branch — dead store write, disagreeing constants, `TOPBAR_H` declared in both files.

**FirstRunWizard `finish` swallows errors** (`FirstRunWizard.tsx:52-78`): four sequential fetches, no `res.ok` checks, a 4xx silently "succeeds" and closes the wizard unconfigured; possible half-written config. "Skip" never POSTs setup, so the wizard reappears every reload.

---

## Category 6 — Type-safety debt

Contained — no literal `any` in the agent layer — but pervasive assertion casts that hide real mismatches: every CopilotKit handler arg is redundantly cast (`path as string`) though the generic already infers them; `as unknown as FrontendAction<T>` (`gated-action.ts:49`); `messages as unknown as ChatMessage[]` (`ToolCallRetry.tsx:48`); `adapter as unknown as Partial<Pollable>` (`jobs.ts:137`); LLM-produced workflow `steps`/`agents` accepted element-unchecked (`generate.ts:71-79`, mitigated by a later `validateWorkflow`). `VersionControls.tsx:7` defines a literal union `| string`, erasing it to `string` so state-name typos compile silently.

---

## Category 7 — Test debt

**Zero unit tests.** No `*.test.*`/`*.spec.*` files under `src/` — coverage rests entirely on 11 Playwright e2e specs (~692 LOC) in `e2e/`. The e2e suite is well-targeted (per-agent capability gating, no-uncommanded-run, candidate/live app flows), but the concurrency and path-jail findings above (C1/C2/H1/H2, scheduler RMW) are precisely the class of bug e2e can't reliably catch and unit tests would. **Recommend:** unit tests around `resolveUnder`/path jails, `isBlockedHost`, the config/scheduler JSON RMW under simulated concurrency, and a manifest-vs-registry drift assertion (would have caught the scheduler-tools drift below).

**Registry "single source of truth" is quietly broken.** The 9 `SCHEDULER_TOOLS` are spread into every sub-agent (`subagents/tools.ts:102`) but absent from `CAPABILITIES` (`capabilities-registry.ts`), so the Settings picker can't scope them — any agent given a non-empty allowlist silently loses all scheduler tools. A one-line test asserting every tool name mentioned in prompts/manifests exists in the registry would catch this and the stale tool-name issue below.

---

## Category 8 — Documentation & consistency debt

**Stale tool names in model-facing prompts.** `instructions.ts:49` tells the model to call `searchMcpTools`/`getMcpToolSchema`/`callMcpTool` (actual ids `mcp_tool_search`/`mcp_tool_schema`/`mcp_tool_call`); `config.ts:35` points the main agent at `web_fetch` (a sub-agent-only tool); similar drift in `OSActions.tsx:29`, `ConfigActions.tsx:55`, `claude-runner.ts:376`, `tools.ts:153`. These make the model hallucinate failing tool calls. `CLAUDE.md`'s "mirror new tools in tool-manifest.ts" is itself stale — the real edit point is `CAPABILITIES` in `capabilities-registry.ts`.

**Personal LAN hostname shipped as a default.** `config/registry.ts:14`: `HARNESS_DEFAULT_URL = ... || "http://wingman.akhbar.lan:7272/mcp"` leaks a private hostname and is a broken default for anyone else.

**Dead code.** `os/apps.ts:16` `getApp`; `gitfs/store.ts:65` `history()`; `review.ts:108` `reflectAndLearn`; `skills/improve.ts:12` `proposeSkillFromConversation`; `tools.ts:203` `SCHEDULER_TOOLS` re-export; `ServiceConfigView.tsx:168` `_icons` (linter-launder); `browser/index.tsx:30` unused `iframeRef`. `OSSettings.theme`/`accent` are persisted and user-editable (`AppearanceTab` color picker) but consumed nowhere — the app hardcodes dark. Either wire them or delete field + picker.

**Oversized modules.** `scheduler/index.tsx` (1,019 lines, 13 components, the only app with no component folder — against the codebase's own `settings/assistant/*` convention); `skills/store.ts` (513, ~130 inline seed content); `conversations.ts` (486); `claude-runner.ts` (446, 4 harness modes + heuristics); `McpServersTab.tsx` (471, a 10-field form as 14 `useState`s).

---

## Category 9 — Performance debt (minor)

**Resize commits to the store every pointermove** (`Window.tsx:87-97`), unlike drag which was deliberately optimized (rAF + imperative transform, single commit on end). Amplified because `Topbar.tsx:28` and `Dock.tsx:8` subscribe to the entire `windows` array, so every resize frame re-renders the topbar, dock, and all open windows. Mirror the drag approach and narrow the selectors. Minor: `playwright/probe.ts:29` uses `existsSync`/`readdirSync` per request (cacheable).

---

## Positive notes (verified healthy)

- Git is injection-safe throughout: `execFile` + argv arrays, fixed/slugified branch names, `--` separators, `..`-prefix filtering in `stageFiles`.
- `atomic-write.ts` is a correct fsync+rename with cleanup; path jails in `vfs`/`docs`/`spec-fs`/`repo-fs` handle Windows backslash traversal.
- The integrations security stack (AES-256-GCM, per-secret IV, mutexed RMW, timing-safe webhook verify, deduped OAuth refresh) is exemplary.
- Server-only boundaries hold: sensitive modules carry `import "server-only"`, `types.ts` is framework-free, client I/O is all `fetch`, per-request store avoids the SSR shared-store trap.
- Secret masking on the config/integrations read paths is correct; the OAuth callback HTML-escapes and JSON-encodes its postMessage payload.
- Capability registry eliminated main-chat action/manifest drift (verified 0 of 70).
- `gen-apps.mjs` is clean (change-detection writes, sorted discovery, safe identifiers) — its one gap is not asserting `manifest.id === folderName`.

---

## Phased remediation plan (alongside feature work)

**Phase 0 — security hotfixes (hours, ship first):** C1, C2 (three one-line jail guards); H5 (redacted MCP view); H6 (`data/` fence). Low-risk, high-impact, no refactor.

**Phase 1 — trust boundary (days):** H2 (DNS-resolving SSRF filter + tests), H3 (restrict `mcp_server_add` transports / consent), H1 (staging-root jail), H4 (temp-dir for `contentOnly`), delete/relabel legacy `bash.ts`, env-allowlist for local exec, server-side action-gate re-checks.

**Phase 2 — data integrity (days):** shared `withLock` mutex on scheduler + workflow RMW; `readJsonSafe` with ENOENT-only fallback for config; `git merge --abort` + un-swallow `commitAll`; VFS seed-promise; draft-install Supervisor check.

**Phase 3 — shared helpers & dedup (1–2 weeks, mostly negative net LOC):** `callBosApi`/`apiFetch` adopted across all `*Actions.tsx` + settings tabs (fixes ~80 fetches and most Category-5 correctness bugs mechanically); `lib/fsutil` (`resolveUnder`, `readJsonSafe`, `withLock`); merge `spec-fs`/`repo-fs`; shared `readNdjson`, modal shell, `AllowlistGrid`, `Input`/`Field`, `useConfigNamespace`.

**Phase 4 — structure & hygiene (ongoing):** decompose `scheduler/index.tsx` and the two stores; move `spec-fs` into `lib/specs`; split `config/registry.ts`; stale-tool-name sweep + a drift test; introduce the first unit tests; remove dead code and the LAN default; wire or delete `theme`/`accent`.
