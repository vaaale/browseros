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

- Gating the active chat: the `*Actions` import `useCopilotAction` from the
  `gated-action.ts` **shim**, which (via `AgentCapabilitiesProvider` →
  `resolveActionGate`) replaces a disallowed action with a **render-only no-op**
  (`available:"disabled"` + `render:()=>null`, dropping `renderAndWaitForResponse`).
  Not just `available:"disabled"`: CopilotKit routes a "disabled" action to its
  RENDER path and calls the action's `render` unconditionally, so a handler-only
  action (no render) would throw "render is not a function" when its tool-call card
  rendered. The no-op keeps it out of the model's tool set AND render-safe; a
  disabled action's own past cards render blank (rare — an agent's conversations
  normally hold only its allowed calls). The catch-all renderer keeps importing
  from CopilotKit (never gated).
- CopilotKit forbids an action's `available` changing after registration, so
  `CopilotProvider` mounts the actions + chat together only once the pinned/active
  agent's allowlist has loaded (and remounts on agent switch).
- Back-compat rule: an action is allowed unless the allowlist names ≥1 action id — so
  unset/legacy (tool-id-only) allowlists keep all actions.
- `SpecActions` (client spec ops over `/api/specs`) let an active-personality agent
  (Build Studio) author specs directly, mirroring the server `SPEC_TOOLS`.

| Component | Actions |
|---|---|
| `OSActions` | `launchApp, listApps, closeWindow, changeWallpaper, openWebPage, listFiles, readFile, writeFile, createFolder, deletePath` |
| `McpActions` | `listMcpServers, findTools, listMcpServerTools, callMcpServerTool, addMcpServer, removeMcpServer` |
| `SpecActions` | `listSpecs, readSpec, writeSpec, editSpec, searchSpecs` (over `/api/specs`) |
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
