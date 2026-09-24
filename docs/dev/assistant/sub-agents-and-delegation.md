# Sub-agents & delegation (and how Claude Code runs)

The assistant delegates substantive work to **sub‑agents**. Definitions live under
`src/lib/agent/subagents/`. **Critical:** all development is done by **Claude**
sub‑agents, never the local provider.

---

## Definitions (`subagents/store.ts`, `types.ts`)

A sub‑agent is `data/agents/<id>/AGENT.md` — markdown with frontmatter
(`name, description, type, model?, subagent_type?, tools?`) and a body (the system
prompt). Parsed/serialized by `subagents/markdown.ts`.

```ts
type SubAgentType = "local" | "claude";
interface SubAgent {
  id; name; description; type; systemPrompt;
  tools?: string[]; model?; subagentType?; ephemeral?;
}
```

**Seeded defaults** — every subfolder of `seed/agents/` is **reconciled** into
`data/agents/` per id on boot (`applySeedAgent`): seeded when absent, refreshed
when BOS's own copy is provably untouched and the shipped version has changed,
and archived to `data/agents/.archive/` when the seed drops the id. A locally
edited agent is never written to. See
[Seed reconciliation](../self-improvement/self-improvement.md#seed-reconciliation)
for the `.seed-rev` stamp, the one-time migration it needs, and why skills work
the same way.

| id | type | role |
|---|---|---|
| `assistant` | local | the default main‑chat **personality** |
| `default_agent` | template | shared prompt prepended to agents with "include default prompt" on |
| `researcher` | local | web research + summaries |
| `build-studio` | local | authors specs under the store's active method; delegates implementation |
| `architect` | local | writes `design.md` for a spec, grounded in BOS's own subsystems |
| `architect-reviewer` | local | independent second pass on a design, verified against real source |
| `ui-designer` | local | turns a spec into a visual mockup inside the spec directory |
| `conversation-reviewer` | local | reviews a past conversation for behavioral problems |
| `devops` | local | resolves git conflicts the scripted pipeline couldn't; escalation only |
| `developer` | **claude** | build apps / modify BOS source (repo‑scoped tools) |

Each conversation carries its own agent id (per‑conversation, the ONLY source of
truth) — there is no global "active agent". A conversation's personality is the
`systemPrompt` of its agent; editing it goes through `setAgentSystemPrompt`.
Ephemeral agents run without being persisted.

---

## Routing: two different engines depending on who's calling (025-agent-delegation-v2)

There are now two distinct entry points into `runSubAgent(agent, task, opts)`
(`subagents/runner.ts`), and only one of them still uses that function at all:

- **Chat-initiated delegation** — the `agent_delegate` / `dev_delegate` tools
  (`src/lib/assistant/tools/server/subagents.ts`, `dev-delegate.ts`) called by a
  live assistant run — does **not** go through `runSubAgent`. It goes through
  `src/lib/assistant/tools/server/delegate-common.ts`'s `delegateToAgent()`,
  which branches on `agent.type`:
  - **`type:"local"`** → `delegate-local.ts`'s `runLocalDelegation()` →
    `src/lib/assistant/inner-loop.ts`'s `runInnerLoop()` — a **second invocation
    of the exact same `runAgentLoop`** the primary run uses (blank in-memory
    transcript, same tools/timeout/`awaitFrontendResult` as the parent run, see
    `docs/dev/assistant/overview.md`). This replaced the old `runToolLoop`
    (`llm.ts`) path entirely for chat delegation.
  - **`type:"claude"`** → `runClaudeAgent` (`claude-runner.ts`), unchanged — see
    below.
  A depth guard (`checkDelegationDepth`, `MAX_DELEGATE_DEPTH = 2`) rejects a
  delegation nested more than two inner loops deep, uniformly across every
  delegation kind, and logs the rejection (`assistant.delegate`).
- **Non-chat / headless callers** — the workflow runner, scheduler executor, the
  Telegram agent router, and `/api/subagents/delegate` — have no live `Run` or
  `ToolContext` to share, so they still call `runSubAgent()` directly.
  `runSubAgent`'s `type:"local"` branch is `runner.ts`'s own `runLocalHeadless()`,
  which *also* now runs a real `runAgentLoop` (not `runToolLoop`) — built with a
  synthetic headless `runId`, an always-open `AbortController`, and
  `awaitFrontendResult` hard-wired to `{kind:"timeout"}` (there is no browser to
  dispatch a frontend tool call to). It imports `agent-loop.ts`/`registry.ts`/
  `gate.ts`/`model-turn.ts` **dynamically** to avoid a real circular dependency
  (`registry.ts → subagents.ts → delegate-common.ts → runner.ts → registry.ts`).
  `type:"claude"` still goes to `runClaudeAgent`, same as the chat path.

  **Headless ephemeral tool fidelity (ADR-12, Workflow Manager service-tools):** a
  `type:"local"` EPHEMERAL agent (supplied inline, never persisted) gets a gate built
  from its in-memory object — `gateFromAgent(agent)`, not `gateFor(id)` (a `getAgent(id)`
  lookup is undefined for it). It honors its declared `deferredTools` (so `find_tools` can
  discover them — see the onEvent note below for how the gate reaches the discovery tool).
  A NAMED agent gets `gateFor(id)` and an empty deferred set (headless = fully visible,
  no discovery round-trip). `headlessGate` filters both down to **server-executable**
  tools, because `awaitFrontendResult` is hard-wired to `{kind:"timeout"}` here.

  **There is no frontend-VFS bridge any more.** ADR-12 added one —
  `bridgeEphemeralFrontendTools` — because `file_read`/`file_write`/… were
  frontend-execution tools that a headless run had no browser to dispatch to. It was
  keyed on `agent.ephemeral`, which left the identical hole open for every headless
  NAMED agent: Build Studio could not create a file at all, while `find_tools` (reading
  the persisted `AGENT.md`, not the enforced gate) kept advertising `file_write` — one
  production run burned 2.3 hours and 69 tool calls on it (EHS-0026). All eleven
  `file_*` tools are ordinary server tools now, so the allowlist filter simply keeps
  them for named and ephemeral agents alike and no bridge is needed.
  See [file tools](../file-tools/file-tools.md).

Three delegation **kinds** share the same `runInnerLoop` primitive and only
differ in how their gate/system-prompt are resolved
(`src/lib/assistant/delegation-gate.ts`):
- **named** — a persisted `data/agents/<id>/AGENT.md` agent (`agent_delegate`/
  `dev_delegate` by id), gate = `gateFor(agentId)`.
- **ephemeral** — a one-off agent whose name/description/systemPrompt/tools are
  supplied inline in the `agent_delegate` call itself, never persisted.
- **surface** — a window-scoped delegate an open app registers for its own
  lifetime (e.g. UI Preview's "Generative UI Agent", `src/apps/ui-preview/
  index.tsx` + `src/lib/assistant/client/surface-agents.ts`'s
  `registerSurfaceAgent()`), discoverable via `find_agent`/`agent_list` only
  while that window stays open, scoped to that surface's own tools
  (`ui_preview_render`, etc.). A surface agent's derived id is checked against
  the persisted roster at registration time (client-side, primary check) and
  again at run-start (`start-run.ts`'s server-side backstop) — either
  collision is logged (`assistant.surface-agents`) and the surface agent is
  dropped, never silently merged with a same-named persisted agent.

`onEvent` streams the inner run's tool activity live in both paths (used by
`/api/subagents/delegate` for headless callers). For the chat path the inner
loop (`inner-loop.ts`) reshapes it into nested progress entries forwarded over
the delegating call's OWN `tool_progress` channel (no new run-event type,
FR-007): each nested `tool_call` start as the legacy `{ tool, input }` shape —
now also carrying the inner `callId` — and, since 045 US2, each nested
`tool_result`/`tool_cancelled` as a typed entry (`{ tool, type, callId,
result? }`), so a running delegation streams its nested completions
individually and the card matches each result to its start by inner `callId`,
not by tool name. The terminal result of the LOCAL path encodes the same
per-child data — `result?`/`status?`/`nested?` on the widened `NestedEvent`
(ADR-3 / B1) — so the done delegation's child-card tree also rebuilds after a
reload; the claude/OpenCode harness stays starts-only (it reports its final
text once, never per-tool results) and encodes `status: "done"` with no
per-child result. (See [Actions & tools](actions-and-tools.md)'s
`nested-events.ts` and the `ToolCardSections.tsx` rendering.)
The headless (`runLocalHeadless`) path additionally emits enriched
events so a consuming service can log the full agent-execution stream —
`{ type:"tool_result", name, result, ok }` (ok/error forwarded from the loop's
in-band `Error: …` convention, not re-derived), `{ type:"reasoning_delta", delta }`,
and `{ type:"final_text", text }` (ADR-13, Workflow Manager service-tools).
`/api/subagents/delegate` forwards these as NDJSON lines alongside the legacy
`{type:"tool"}` (per tool call) and the terminal `{type:"done", result, text}` /
`{type:"error"}` lines — the `done` line also carries the agent's final response
text as `text` (additive; `result` is unchanged) — preserving the pre-patch
`{type:"tool"}` shape for backward compatibility.
The headless run also registers the ephemeral agent in a tiny runId-keyed in-run
registry (`subagents/in-run-agents.ts`) so `find_tools` (tools/server/discovery.ts)
can resolve its gate from that object; named runs are never registered, so named
discovery still resolves via `gateFor(agentId)`. `featureBranch` still drives
source-edit ownership for the `type:"claude"` path — see below.

Every delegation's start/finish is logged to `assistant.delegate` (kind,
agentId, depth, steps, reason — never the task string or tool
arguments/results), queryable in Settings → Logs, filterable by `component` and
`conversation`.

---

## Tools a sub-agent may use

`subagents/tools.ts` (the old `SUBAGENT_TOOLS`/`DEV_TOOLS`/`toolsFor()` split)
was retired — there is now **one** tool registry
(`src/lib/assistant/registry.ts`) shared by the primary run and every
delegation kind. What a given agent may call is just its resolved **gate**
(`src/lib/assistant/gate.ts`'s `gateFor(agentId)` / `gateFromAgent(agent)`):
the intersection of the agent's own `tools`/`deferredTools` ids against that
registry, plus Settings description overrides. An ephemeral delegation's gate
(`ephemeralDelegationGate`) is filtered further to **server-execution-only**
tools (no frontend/Tier-2 tools — there's no dedicated UI surface for an
ephemeral agent to dispatch them against).

- The dev-only tools formerly in `DEV_TOOLS` still exist, just as ordinary
  registry entries an agent opts into via its `tools` list: `bos_source_list` /
  `bos_source_read` / `bos_source_search` (`src/lib/assistant/tools/server/
  dev-source.ts`, via `src/lib/dev/repo-fs.ts` — read‑only, jailed to the repo
  root) and `dev_git_status`.
- `run_command` (sandboxed exec) and `dev_delegate` are still built **per run**
  (not static registry entries) with a `(browser‑session, agent)` sandbox key
  — see [Command Execution](../run-command/run-command.md).
- An agent id that lists a tool id **not** in the registry is never silently
  dropped: `unresolvedToolIds()` flags it, `gateFor`/`gateFromAgent` logs a
  warning (`assistant.agents`), and Settings → Agents surfaces it per-agent
  (`GET /api/subagents`'s `unresolvedToolIds` field) so a stale reference (e.g.
  a tool renamed or removed since the agent's `AGENT.md` was last edited) is
  visible instead of just quietly doing nothing.

---

## How the dev agent runs (`claude-runner.ts` + `devharness/harness-config.ts`)

`getHarnessConfig()` resolves the `dev-harness` namespace to
`{ mode:"cli", tool:"claude"|"opencode", cwd } | { mode:"mcp", server }`, where
`cwd` is derived from the running BOS process. The user cannot configure it; source
edits are always re-pointed to the Supervisor preview worktree before the harness
starts. Only the binary and event parsing differ — the Supervisor worktree,
build‑gate, and staging are harness‑agnostic.

- **`cli` tool `claude` (default & recommended):** spawn
  `claude -p <task> --append-system-prompt <agent prompt> --output-format
  stream-json --verbose --dangerously-skip-permissions`. BOS parses the stream‑json
  (`type:"assistant"` → `content[].tool_use` for live events; `type:"result"` →
  `result`/`is_error`).
- **`cli` tool `opencode`:** spawn `opencode run <prompt> --format json --dir <cwd>
  --auto [--model …]`. OpenCode has no inline system‑prompt flag, so the agent
  prompt is **prepended to the message** (like the MCP path) to avoid writing an
  `opencode.json` the Supervisor would commit. BOS also aligns `PWD` with `<cwd>` so
  OpenCode cannot resolve the base checkout when the Supervisor supplied an isolated
  preview worktree. BOS parses the newline‑delimited events (`tool_use` → `part`
  `ToolPart` for live events, de‑duped by `callID`; `text` → cumulative `part.text`
  per id = final output; `error`).
- Both CLI tools: permissions skipped → **run sandboxed (e.g. Docker)**; files are
  `git add`‑ed afterward as a backstop; ~590s timeout.
- **`mcp`:** connect to a Claude Code MCP server (stdio `claude mcp serve` or remote
  HTTP/SSE) and drive its `Agent` tool with a generated `subagent_type`. For source
  edits, only stdio MCP is allowed because BOS can spawn it in the Supervisor's
  preview worktree; remote MCP is refused because BOS cannot enforce its working
  directory. ⚠️ The
  `Agent` tool only spawns sub‑agent types **registered at the harness's startup**;
  if none match it returns `HARNESS_UNAVAILABLE` and the CLI path is preferred.
  (OpenCode is **CLI‑only** here — it isn't exposed over this MCP `Agent` path.)

### Provider selection & MCP-server inclusion (`devharness/provider.ts` + `devharness/generate-config.ts`, `029-settings-dev-harness`)

On top of the credential-file login above, Settings → Dev Harness lets the user pick
a per-CLI **provider** — Claude: `default` (credential-file login, unchanged) |
`api-key` | `bedrock` | `vertex`; OpenCode: `default` (`auth.json` login, unchanged) |
a named `provider` — and any MCP server (`src/lib/mcp/`) can be flagged
`includeInDevHarness` (default `false`) to fold it into the harness too.
`regenerateHarnessConfigFiles()` (`generate-config.ts`) reads both and **generates**
(full replace, never merged) three files under the harness `HOME` — **not** the
`cwd`/worktree, so this is unrelated to (and doesn't reintroduce) the "avoid writing
an `opencode.json` the Supervisor would commit" concern above:

- `.claude/settings.json` — Claude's provider `env` block (`ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_USE_BEDROCK`, etc.).
- `.claude.json` — Claude's `mcpServers` (**not** `settings.json` — Claude Code
  doesn't read MCP servers from there), from every `includeInDevHarness` server.
- `.config/opencode/opencode.json` — OpenCode's `provider`/`model` fields plus its
  `mcp` block, from the same server list. If a **Context window** was set for the
  OpenCode model, it's also written as that provider's
  `models.<modelId>.limit.context` — OpenCode has no way to know BOS's model
  catalog on its own, so without this it silently falls back to its own built-in
  default context size for the model, which can be wrong and let a run overflow.

A file is deleted (not left empty) when it has nothing to say — e.g. provider left
`default` and no servers flagged — which is also how
`harnessCredentialEnv()`'s `HOME`/`XDG_*` redirection gate knows there's something
to honor: it checks `hasClaudeCreds() || hasOpenCodeAuth() || hasGeneratedHarnessConfig()`
(existence of any of the three files above), not just the credential files, so a
provider- or MCP-only setup (no pasted credentials) still gets redirected correctly.

---

## Delegation + the Supervisor (code candidates)

`runClaudeAgent` integrates with live version control:

- For source edits, `runClaudeAgent` refuses to run unless BOS is served under the
  **Supervisor** and the caller supplied a validated active `featureBranch`
  (`bos/<kebab-name>`). There is no in-place fallback: the harness must edit an
  isolated feature-branch worktree or fail without applying changes.
- The branch is resolved **server-side**, not exposed as an LLM tool parameter.
  Chat delegation (`delegate-common.ts`) resolves it in-process from the
  delegating tool call's own `ctx.conversationId` via
  `getConversationActiveFeatureBranch()` — never a parameter the model can set.
  Headless callers going through `/api/subagents/delegate` resolve it the same
  way from the conversation id in the request body. Automation may pass
  `featureBranch` directly to trusted server APIs. If no branch resolves, an
  in-band error is returned before Claude/OpenCode/MCP is spawned.
- It calls `supervisorBegin(featureBranch)` to provision (or **resume**) the
  isolated preview worktree (+ data clone), points the dev harness's `cwd` there,
  runs, then calls `supervisorBuild(featureBranch)` to build + health-gate the
  preview.
- Promote deletes the merged branch/worktree/instance. On Supervisor restart,
  `bos/*` branches are rediscovered as `not-built` previews and can be selected
  again from the toolbar.
- **`contentOnly:true`** (e.g. generating an app's HTML — a *content* op) MUST NOT
  provision a code candidate; the result is installed via `app_install` onto the
  feature branch's coupled `user-apps` worktree instead.
- BrowserOS source analysis or implementation MUST NOT use `contentOnly:true`.
  `contentOnly` is reserved for standalone app content generation, and the
  runner refuses source-shaped tasks submitted through that bypass.

See [Live version control](../self-modification/live-version-control.md).

---

## The CORE_POLICY contract (`src/lib/agent/config.ts`)

The always‑on policy mandates: delegate substantive tasks; **Claude for any
coding**; pick the right app path (simple static `app_install` vs. project `app_build`,
both as previews); modify BOS only via the `developer` agent (never via the VFS);
ask permission (`agent_request_claude`) before using Claude for a
**non‑dev** task; save durable memory but not transient failures; call
`skill_reflect` after non‑trivial tasks; keep the docs under `docs/usage`/`docs/dev` current.

---

## Recipe: add a sub-agent

`agent_create` action, or add to `DEFAULTS` in `subagents/store.ts`. Use
`type:"claude"` for coding agents; give local dev agents the repo‑scoped `tools` ids
if they should edit source.
