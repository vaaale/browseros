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

**Seeded defaults** (only when `data/agents` is empty):

| id | type | role |
|---|---|---|
| `assistant` | local | the default main‑chat **personality** |
| `researcher` | local | web research + summaries |
| `file-organizer` | local | tidy the VFS |
| `writer` | local | drafting/editing |
| `planner` | local | produce a plan with acceptance criteria |
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

`onEvent` streams `{ tool, input }` events live in both paths (used by
`/api/subagents/delegate` for headless callers; forwarded as nested
tool-call/tool-result events for the chat path — see
[Actions & tools](actions-and-tools.md)'s `nested-events.ts`/`NestedEventList`
rendering). `featureBranch` still drives source-edit ownership for the
`type:"claude"` path — see below.

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
  GitFS `app-candidate` branch instead.
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
