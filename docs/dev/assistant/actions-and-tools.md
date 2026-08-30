# Assistant actions, tools & event rendering

> **Stale (v1 CopilotKit path):** most of this doc describes the retired
> `useCopilotAction`/`/api/copilotkit` chat path (CLAUDE.md: "CopilotKit is retired from
> the chat path; it remains only as a markdown renderer"). Current tool wiring for the
> v2 server-owned runs lives in `src/lib/assistant/registry.ts` +
> `src/lib/assistant/tools/server/*` (server tools) and
> `src/lib/assistant/tools/frontend-declarations.ts` +
> `src/components/agent/v2/FrontendToolsV2.tsx` (frontend tools) — see CLAUDE.md's
> Assistant section. The capability registry (`src/lib/agent/capabilities-registry.ts`,
> referenced below) is still the live source of truth for tool ids/gating; the
> `*Actions.tsx` component list is not. A third source of `AssistantTool` entries
> exists alongside built-ins: a marketplace service's own declared tools
> (`deploymentMode: "tools"`, 039-service-tool-exposure) register dynamically into
> this same capability registry at runtime and are gated identically — see
> [Service daemons §15](../apps/services.md#15-services-as-native-assistant-tools-deploymentmode-tools-039-service-tool-exposure).

## Actions (tools)

Each `src/components/agent/*Actions.tsx` registers tools with
`useCopilotAction({ name, description, parameters, handler })`. Handlers run
**client‑side** and call BOS `/api/...` routes for server work. The v2 tool-call card
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
- `SpecActions`/`DocsActions` (client spec/docs ops, `spec_list`/`spec_read`/`spec_write`/
  `spec_edit`/`spec_search` and `docs_list`/`docs_read`) are **retired** — spec and docs
  access now goes through the generic `file_*` tools against the `/Specs`, `/Docs`, and
  `/Templates` VFS mounts (`src/lib/specs/spec-mount.ts`), same as any other file path.

Tool naming standard: `subsystem_object_verb`, snake_case, one id per operation
(see `src/lib/agent/capabilities-registry.ts`). Duplicated main-chat action /
sub-agent tool pairs are collapsed into a single id (`context: "both"`), so e.g.
the main chat and a delegated sub-agent both use `file_read`.

| Component | Actions |
|---|---|
| `OSActions` | `bos_app_launch, bos_app_list, bos_window_close, bos_wallpaper_set, bos_browser_open, web_view, file_list, file_read, file_write, file_mkdir, file_delete, file_rename` |
| `McpActions` | `mcp_server_list, mcp_tool_search, mcp_server_tools, mcp_tool_schema, mcp_tool_call, mcp_server_add, mcp_server_remove` |
| `WebSearchActions` | `web_search` (Anthropic native web search over `/api/web-search`) |
| `SubAgentActions` | `agent_list, agent_create, agent_delegate, agent_request_claude, dev_branch_request` (elicitation card) |
| `MemoryActions` | `memory_save` (add/replace/remove, batch), `memory_recall` |
| `FrontendToolsV2` | `app_install, app_build, app_list, app_uninstall` (agent prompt get/set are server tools in `tools/server/agent-admin.ts`) |
| `ConfigActions` | `config_list, config_set` |
| `SkillsActions` | `skill_list, skill_load, skill_read_file, skill_save` |
| `SelfImprovementActions` | `skill_reflect, skill_improve, skill_curate` |
| `GitActions` | `dev_git_status` |
| `RunCommandActions` | `run_command` (sandboxed exec; Settings → Command Execution) |
| `IntegrationActions` | GSuite actions (`gmail_*`, `drive_*`, `calendar_*`, `contacts_*`) and Telegram bot actions (`bot_*`) generated from adapter method descriptors |

> Removed: `switchAssistantAgent` (agents delegate, they don't self-switch roles),
> the unsandboxed `runBash` tool (replaced by `run_command`), and the legacy MCP
> aliases `findTools`/`callMcpServerTool`.

> Other components: `AssistantChatV2` (mounts everything), the run event stream
> (per‑conversation load/save + auto‑title), `ToolCallRetry`,
> `MarkdownRenderers`, `components/agent/v2/ToolCallCard.tsx`.

### `web_view` — documents *and* media

`web_view` opens the hidden built‑in `html-viewer` app (`src/apps/html-viewer/`)
on `html`, `filePath`, or `url`, with `title` / `update`. It has **two render
modes**, chosen by the handler and passed to the app as an explicit `mode` param:

| Target | App params | Rendered as |
|---|---|---|
| HTML document / non‑media URL | `{ html }` or `{ url, title? }` | `<iframe sandbox="allow-scripts">` (unchanged) |
| Image or video | `{ mode: "image"\|"video", src, title, poster?, autoplay?, loop?, muted? }` | native `<img>` / `<video controls>` centered and `object-contain` on a `#1a1a1a` stage |

- **Classification lives in the handler, not the app** — `classifyMediaTarget()` in
  `src/lib/apps/media.ts` (framework‑free) is imported by **both** the v2 handler
  (`v2/FrontendToolsV2.tsx`) and the v1 action (`OSActions.tsx`) so they cannot
  drift. It reads the extension from a `/api/fs/raw?path=…` target's `path`, from a
  plain URL's pathname (query stripped), or the MIME prefix of a `data:` URI, and
  returns `null` (→ document mode) for anything unmapped, including `audio/*`.
- **Virtual media endpoints are detected via the query string.** When the pathname
  has no media extension (e.g. ComfyUI's
  `http://host:8188/view?filename=clip.mp4&subfolder=video&type=output`), the
  classifier falls back to the query: `filename`, `file`, `path`, `name` in that
  order, then any param whose value ends in a known media extension. Only a value
  with a renderable extension counts, so `?redirect=/home` never flips a document
  into media mode. `mediaTargetLabel()` reads the same source, so the window is
  titled `clip.mp4` and not `view`.
- `IMAGE_EXTENSIONS` / `VIDEO_EXTENSIONS` mirror the raw route's `MIME` map in
  `src/app/api/fs/raw/route.ts` — **change both together**, or the tool claims a
  target is video while the route serves it as `application/octet-stream`.
- **Media params:** `poster` (a leading‑`/` VFS path is rewritten to a raw URL by
  the same rule as `url`/`filePath`), `autoplay`, `loop`, `muted` — video only.
  Unmuted `autoplay` is blocked by browser policy; the app syncs `muted` onto the
  element imperatively so `muted` + `autoplay` is honoured.
- **External media is proxied same‑origin** through `src/app/api/media-proxy/route.ts`
  (`/api/media-proxy?src=<encodeURIComponent(url)>`). Both handlers rewrite `src`
  (and `poster`) with `proxiedMediaUrl()` from `src/lib/apps/media.ts`, which
  proxies only what `needsProxy()` flags — an absolute `http(s)://` URL whose
  origin differs from `window.location.origin`. Same‑origin `/api/fs/raw` targets
  and `data:` URIs are left alone. Without this, an `http://` LAN endpoint (a
  ComfyUI box) is killed as **mixed content** on an HTTPS BOS page before the
  element requests a byte. Classification and `mediaTargetLabel()` still read the
  **original** target — only the transport changes.
  The route forwards `Range` and relays the upstream `206` + `Content-Range` (so
  seeking works), relays `Content-Type`/`Content-Length` verbatim, passes
  `fetch`'s Web `ReadableStream` straight through (**never buffers** — videos are
  hundreds of MB), sets `Cache-Control: no-store`, and adds **no CORS headers**
  (it is same-origin by construction). Its 15 s timeout covers **response headers
  only** — cleared once `fetch` resolves, because a legitimate large video streams
  for minutes. An unreachable upstream or a non‑2xx status becomes a **502** with a
  JSON `{ error }`, which is what makes the element's `onError` fire (FR‑011).
  It is **not** the Browser app's `/api/proxy`: that rewrites HTML, caps bodies at
  6 MiB, and applies the `isBlockedHost` SSRF guard — which blocks the RFC‑1918 /
  `*.local` hosts this route exists to reach (SC‑006).
- **Media is deliberately NOT wrapped in the sandboxed iframe.** An image or video
  stream carries no executable code on the parent origin (SVG in an `<img>` is
  script‑inert), so the boundary buys nothing there while it *blocks* the video's
  native fullscreen button. The iframe boundary is preserved for document content,
  where arbitrary agent HTML/JS must not reach BOS APIs.
- **Errors:** the handler's existing verify‑fetch for `/api/fs/raw` targets returns
  a tool *failure* for a missing VFS file (no window opens). Unrenderable media
  (bad external URL, unsupported codec) fires `onError` and shows a centered
  "Could not load: …" card on the stage. External URLs are not verified
  server‑side.
- The media element is keyed on `src`, so `update=true` always re‑fetches.
- User‑facing docs: [Previewing content (`web_view`)](../../usage/assistant/web-view.md).

### The Tools panel manifest

`src/lib/agent/tool-manifest.ts` (`ASSISTANT_TOOLS`) is derived from
`capabilities-registry.ts`, shown in the Assistant's right **Tools** panel grouped
by area. It is display-only — it does not register tools.

---

## Event rendering

- **`ReasoningAssistantMessage.tsx`** parses `<think>…</think>` into a reasoning
  disclosure and always renders the default assistant message (so tool/subComponent
  UI shows).
- **`components/agent/v2/ToolCallCard.tsx`** renders each tool call as a collapsible native
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
   component mounted in `AssistantChatV2`). The handler hits a `/api/...` route
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
  same id as the server tool in `src/lib/assistant/tools/server/web-search.ts`
  (the single registry shared by the primary run and every delegation kind —
  see [Sub-agents & delegation](sub-agents-and-delegation.md)).
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
