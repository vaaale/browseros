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

The **active personality** is just one of these agents, stored as an id in the
`assistant` config namespace (`getActiveAgentId` / `setActiveAgentId` /
`getActiveAgentBody` / `setAgentSystemPrompt`). There is no separate "profile" store.
Ephemeral agents run without being persisted.

---

## Routing (`subagents/runner.ts`)

`runSubAgent(agent, task, { onEvent?, contentOnly?, branchKey?, interactive? })`:

- **`type:"local"`** → `runLocal` → `runToolLoop` (`llm.ts`) with the configured
  provider and the agent's tools. A local agent holding repo‑scoped dev tools gets a
  larger step budget (`DEV_MAX_STEPS = 40`) and its files are `git add`‑ed afterward
  as a backstop. Errors are returned, not thrown. `branchKey`/`interactive` are
  forwarded to a nested `delegateToDeveloper` so escalated dev work stays on the same
  feature branch.
- **`type:"claude"`** → `runClaudeAgent` (`claude-runner.ts`). **No local fallback**
  — development is Claude‑only by design.

`onEvent` streams `{ tool, input }` events live (used by `/api/subagents/delegate`).
`branchKey` + `interactive` drive feature‑branch selection — see below.

---

## Tools a sub-agent may use (`subagents/tools.ts`)

- **`SUBAGENT_TOOLS`** (default, safe): `list_files`, `read_file`, `write_file`,
  `create_folder` (the **VFS**), and `web_fetch`.
- **`DEV_TOOLS`** (repo‑scoped, **opt‑in** — an agent must list these ids in its
  `tools`):
  - `list_source` / `read_source` / `search_source` / `write_source` /
    `edit_source` via `src/lib/dev/repo-fs.ts` — **jailed to the repo root**; reads
    deny `.env*`/`.git`/`node_modules`/`.next`; **writes allowed only under** `src/`,
    `specs/`, `public/`, `docs/`, `data/`.
  - `run_command` via `src/lib/dev/run-command.ts` — fixed allowlist
    (`typecheck`→`npx tsc --noEmit`, `lint`→`npx eslint .`, `build`→`npm run build`,
    `e2e`), `execFile` (no shell).
  - `git_branch` / `git_stage` / `git_status` via `src/lib/system/git.ts`.

`toolsFor(allowed?)` returns `SUBAGENT_TOOLS` when no allowlist is given — **never**
the dev tools implicitly.

---

## How the dev agent runs (`claude-runner.ts` + `devharness/harness-config.ts`)

`getHarnessConfig()` resolves the `dev-harness` namespace to
`{ mode:"cli", tool:"claude"|"opencode", cwd } | { mode:"mcp", server }`. Both CLI
tools spawn a headless coder that edits source in `cwd`; only the binary and event
parsing differ — the Supervisor worktree, build‑gate, and staging are harness‑agnostic.

- **`cli` tool `claude` (default & recommended):** spawn
  `claude -p <task> --append-system-prompt <agent prompt> --output-format
  stream-json --verbose --dangerously-skip-permissions`. BOS parses the stream‑json
  (`type:"assistant"` → `content[].tool_use` for live events; `type:"result"` →
  `result`/`is_error`).
- **`cli` tool `opencode`:** spawn `opencode run <prompt> --format json
  --dangerously-skip-permissions [--model …]`. OpenCode has no inline system‑prompt
  flag, so the agent prompt is **prepended to the message** (like the MCP path) to
  avoid writing an `opencode.json` the Supervisor would commit. BOS parses the
  newline‑delimited events (`tool_use` → `part` `ToolPart` for live events, de‑duped
  by `callID`; `text` → cumulative `part.text` per id = final output; `error`).
- Both CLI tools: permissions skipped → **run sandboxed (e.g. Docker)**; files are
  `git add`‑ed afterward as a backstop; ~590s timeout.
- **`mcp`:** connect to a Claude Code MCP server (stdio `claude mcp serve` or remote
  HTTP/SSE) and drive its `Agent` tool with a generated `subagent_type`. ⚠️ The
  `Agent` tool only spawns sub‑agent types **registered at the harness's startup**;
  if none match it returns `HARNESS_UNAVAILABLE` and the CLI path is preferred.
  (OpenCode is **CLI‑only** here — it isn't exposed over this MCP `Agent` path.)

---

## Delegation + the Supervisor (code candidates)

`runClaudeAgent` integrates with live version control:

- If served under the **Supervisor** and the task is **not** `contentOnly`, it
  resolves the feature branch from `branchKey` (an **opaque** stable id — a chat's
  conversation id, a workflow id, an external `gitlab-issue:1234`, …), then calls
  `supervisorBegin(branch)` to provision (or **resume**) the isolated preview worktree
  (+ data clone), **re‑anchors the key → branch** (`thread-branches.ts`:
  `getBranchForKey`/`setBranchForKey`), points Claude's `cwd` there, runs, then calls
  `supervisorBuild()` to build + health‑gate the preview.
- **Branch selection depends on `interactive`:**
  - **interactive** (a chat session): a currently‑**previewed** branch wins ("improve
    the thing I'm looking at"), then the key's remembered branch, else a fresh
    `bos/next-*`.
  - **headless** (workflow / integration): the key is **authoritative** — its own
    remembered branch (fresh on first use), and it **never** adopts a human's stray
    live preview. With no key, every run gets a fresh branch.
- **Who supplies it:** the chat sends the active conversation id as `branchKey` with
  `interactive:true` (`SubAgentActions`); the workflow runner sends `workflow:<id>`
  (or a per‑run override) headless; any integration may POST its own id to
  `/api/subagents/delegate`. Promote deletes the merged branch, so the next run on
  that key resolves to a fresh branch off the new base (the anchor self‑heals because
  `provisionPreview` re‑creates a missing branch off base).
- **`contentOnly:true`** (e.g. generating an app's HTML — a *content* op) MUST NOT
  provision a code candidate; the result is installed via `installApp` onto the
  GitFS `app-candidate` branch instead.

See [Live version control](../self-modification/live-version-control.md).

---

## The CORE_POLICY contract (`src/lib/agent/config.ts`)

The always‑on policy mandates: delegate substantive tasks; **Claude for any
coding**; pick the right app path (simple static `installApp` vs. project `buildApp`,
both as previews); modify BOS only via the `developer` agent (never via the VFS);
ask permission (`requestClaudeAgentPermission`) before using Claude for a
**non‑dev** task; save durable memory but not transient failures; call
`reflectAndLearn` after non‑trivial tasks; keep the docs under `docs/usage`/`docs/dev` current.

---

## Recipe: add a sub-agent

`createSubAgent` action, or add to `DEFAULTS` in `subagents/store.ts`. Use
`type:"claude"` for coding agents; give local dev agents the repo‑scoped `tools` ids
if they should edit source.
