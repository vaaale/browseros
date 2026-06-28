# Assistant actions, tools & event rendering

## Actions (tools)

Each `src/components/agent/*Actions.tsx` registers tools with
`useCopilotAction({ name, description, parameters, handler })`. Handlers run
**client‑side** and call BOS `/api/...` routes for server work. `ChatToolRenderer`
registers a wildcard action (`name:"*"`) to render every tool call as a card.

| Component | Actions |
|---|---|
| `OSActions` | `launchApp, listApps, closeWindow, changeWallpaper, openWebPage, listFiles, readFile, writeFile, createFolder, deletePath` |
| `McpActions` | `listMcpServers, addMcpServer, removeMcpServer, probeMcpServer` |
| `SubAgentActions` | `listSubAgents, createSubAgent, delegateToSubAgent, requestClaudeAgentPermission` (elicitation card) |
| `MemoryActions` | `memory` (add/replace/remove, batch), `recallMemories` |
| `DevActions` | `installApp, buildApp, listInstalledApps, uninstallApp, getMyInstructions, updateMyInstructions` |
| `ConfigActions` | `listConfigurableSettings, updateSetting` |
| `AssistantActions` | `switchAssistantAgent` |
| `SkillsActions` | `loadSkill, saveSkill` |
| `SelfImprovementActions` | `reflectAndLearn, improveSkill, runCurator` |
| `DocsActions` | `listDocs, readDoc` |
| `GitActions` | `gitStatus, startFeatureBranch, stageChanges` |
| `WorkflowActions` | `createWorkflow, modifyWorkflow, runWorkflow, getStatus, cancelWorkflow, exportWorkflow, validateWorkflow` |

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
2. Mirror it in `tool-manifest.ts` (Tools panel).
3. Prefer extending an existing grouping over creating new components.
