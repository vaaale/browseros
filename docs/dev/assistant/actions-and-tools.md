# Assistant actions, tools & event rendering

## Actions (tools)

Each `src/components/agent/*Actions.tsx` registers tools with
`useCopilotAction({ name, description, parameters, handler })`. Handlers run
**client‑side** and call BOS `/api/...` routes for server work. `ChatToolRenderer`
registers a wildcard action (`name:"*"`) to render every tool call as a card.

### Per-agent capability gating (one agent, one allowlist — `specs/016-unified-agents/`)

"Sub-agent" is a role, not a type: an agent has ONE capability allowlist that governs
it whether it's the **active personality** (main-chat actions) or **delegated to**
(server `toolsFor()` tools). The single source of truth is the **capability registry**
(`src/lib/agent/capabilities-registry.ts`): every tool by stable id, tagged with the
context(s) it runs in (`action` / `tool` / `both`). `tool-manifest.ts` is a view of it.

- Gating the active chat: all `*Actions` register plainly with CopilotKit. The
  `/api/copilotkit` route wraps the AI SDK language model with `withToolGate`,
  which filters the tool schema before each model step using the active agent's
  strict `tools` allowlist, the registry default deferred set, and that agent's
  per-agent `deferredTools`.
- Deferred discovery: `DiscoveryActions` always registers `find_tools` and
  `find_agent`. `find_tools` returns matching deferred tool ids and schemas;
  `withToolGate` derives the revealed ids from prior `find_tools` tool results in
  the conversation transcript, so no frontend reveal store is needed.
- Compaction order matters: the tool gate wraps outside the compaction middleware
  so it can inspect the full transcript for prior `find_tools` results before
  compaction shrinks the prompt sent to the provider.
- Back-compat rule: legacy agents are migrated once to an explicit full tool
  allowlist. After migration, an empty `tools` allowlist means zero registry
  tools.
- `SpecActions` (client spec ops over `/api/specs`) let an active-personality agent
  (Build Studio) author specs directly, mirroring the server `SPEC_TOOLS`.

Tool naming standard: `subsystem_object_verb`, snake_case, one id per operation
(see `src/lib/agent/capabilities-registry.ts`). Duplicated main-chat action /
sub-agent tool pairs are collapsed into a single id (`context: "both"`), so e.g.
the main chat and a delegated sub-agent both use `file_read`.

| Component | Actions |
|---|---|
| `OSActions` | `bos_app_launch, bos_app_list, bos_window_close, bos_wallpaper_set, bos_browser_open, web_view, file_list, file_read, file_write, file_mkdir, file_delete` |
| `McpActions` | `mcp_server_list, mcp_tool_search, mcp_server_tools, mcp_tool_schema, mcp_tool_call, mcp_server_add, mcp_server_remove` |
| `WebSearchActions` | `web_search` (Anthropic native web search over `/api/web-search`) |
| `SpecActions` | `spec_list, spec_read, spec_write, spec_edit, spec_search` (over `/api/specs`) |
| `SubAgentActions` | `agent_list, agent_create, agent_delegate, agent_request_claude, dev_branch_request` (elicitation card) |
| `MemoryActions` | `memory_save` (add/replace/remove, batch), `memory_recall` |
| `DevActions` | `app_install, app_build, app_list, app_uninstall, agent_prompt_get, agent_prompt_set` |
| `ConfigActions` | `config_list, config_set` |
| `SkillsActions` | `skill_list, skill_load, skill_read_file, skill_save` |
| `SelfImprovementActions` | `skill_reflect, skill_improve, skill_curate` |
| `DocsActions` | `docs_list, docs_read` |
| `GitActions` | `dev_git_status` |
| `RunCommandActions` | `run_command` (sandboxed exec; Settings → Command Execution) |
| `WorkflowActions` | `workflow_create, workflow_modify, workflow_run, workflow_status, workflow_cancel, workflow_export, workflow_validate` |

> Removed: `switchAssistantAgent` (agents delegate, they don't self-switch roles),
> the unsandboxed `runBash` tool (replaced by `run_command`), and the legacy MCP
> aliases `findTools`/`callMcpServerTool`.

> Other components: `CopilotProvider` (mounts everything), `ChatPersistence`
> (per‑conversation load/save + auto‑title), `ToolCallRetry`,
> `ReasoningAssistantMessage`, `MarkdownRenderers`, `ChatToolRenderer`.

### The Tools panel manifest

`src/lib/agent/tool-manifest.ts` (`ASSISTANT_TOOLS`) is a **curated mirror** of the
above, shown in the Assistant's right **Tools** panel grouped by area. **Keep it in
sync** when you add/remove an action (it's display‑only — it does not register
tools).

---

## Event rendering

- **`ReasoningAssistantMessage.tsx`** parses `<think>…</think>` into a reasoning
  disclosure and always renders the default assistant message (so tool/subComponent
  UI shows).
- **`ChatToolRenderer.tsx`** renders each tool call as a collapsible native
  `<details>` card; renders live delegation events, nested sub‑agent trees, and
  MCP‑UI iframes.
- **`card-collapse.ts`** is a **module‑level store with timers OUTSIDE the React
  lifecycle** — the chat remounts cards while streaming, so a per‑component timer
  would be cleared and never fire. Use `markComplete(id)` (auto‑collapse) /
  `useCollapsed(id)`.
- **`subagent-events.ts`** is a live store keyed by task; `/api/subagents/delegate`
  streams **NDJSON** (`{type:"tool"}` per event, then `{type:"done"|"error"}`) so
  sub‑agent activity appears live, not at the end.
- **`nested-events.ts`** encodes/parses a `BOS-NESTED` marker for nested rendering.
- **`MarkdownRenderers.tsx`** renders fenced ```` ```html ```` as a sandboxed iframe
  preview.

---

## Conversations (`src/lib/agent/conversations.ts`)

- One JSON file per chat at `/Documents/Chats/<id>.json` in the **VFS** (metadata +
  messages). Active id cached in `localStorage`.
- `useConversations()` / `useActiveConversationId()` (a `useSyncExternalStore`),
  plus `newConversation`, `selectConversation`, `deleteConversation`,
  `renameConversation`, `loadConversationMessages`, `saveConversationMessages`.
- **Safety:** `loadConversationMessages` trims to a settled tail
  (`conversations-sanitize.ts` `trimToSettledTail`) so reopening a chat never
  resumes an in‑flight turn; `saveConversationMessages` refuses to overwrite a
  non‑empty thread with an empty snapshot (guards against remount wipes).
- **Auto‑title:** after the first settled user/assistant pair,
  `maybeGenerateTitleInBackground` posts to `/api/assistant/title` and renames the
  thread — never overwriting a user‑set title; isolated from the visible chat.

---

## Adding an action (recipe)

1. Add a `useCopilotAction({...})` in the most relevant `*Actions.tsx` (or a new
   component mounted in `CopilotProvider.tsx`). The handler hits a `/api/...` route
   for server work.
2. Add the capability to `src/lib/agent/capabilities-registry.ts` with the right
   `context` and `deferred` default so `/api/copilotkit` can gate it.
3. Prefer extending an existing grouping over creating new components.

---

## Web Search

`src/lib/agent/web-search.ts` is the shared server-only implementation for native
web search. It validates `WebSearchInput`, calls Anthropic
`client.beta.messages.create()` with the `web_search_20250305` server tool, parses
`web_search_tool_result`, `server_tool_use`, and `text` response blocks, and formats
results for model consumption.

Entry points:

- `web_search` — main chat action in `src/components/agent/WebSearchActions.tsx`;
  same id as the sub-agent tool in `src/lib/agent/subagents/tools.ts`.
- API route: `POST /api/web-search` in `src/app/api/web-search/route.ts`.

Constraints:

- Native web search is currently Anthropic-only and requires an Anthropic API key.
- `query` is required, trimmed, and limited to 2-1000 characters.
- `allowed_domains` and `blocked_domains` are mutually exclusive, max 20 domains,
  max 253 characters per domain, and must be domains rather than URLs.
- The API route accepts `application/json` only and applies a simple in-memory limit
  of about 20 searches per client per 10 minutes.
- Any answer that uses web search results must cite the relevant source URLs.

`web_fetch` remains unchanged: use it when the agent already has a specific URL to
read. Use `webSearch`/`web_search` when the agent needs to discover current sources.
