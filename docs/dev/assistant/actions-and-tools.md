# Assistant actions, tools & event rendering

## How a tool reaches the model

Tools are NOT listed in the system prompt. They travel in the provider's own
tool-calling field — `tools:` on Anthropic's `messages.create`, `tools:` on
OpenAI chat/responses (`src/lib/assistant/model-turn.ts`) — which the provider
renders into the model's context itself. That field is a FLAT list of
`{name, description, schema}` with no grouping metadata in either wire format.

What BOS controls is *which* tools go into it. `visibleTools(tools, gate, revealed)`
(`src/lib/assistant/tools.ts`) is recomputed on every step by the agent loop
(`agent-loop.ts`), applying:

1. the agent's **allowlist** (016-unified-agents),
2. the per-agent **deferred** set (025), minus whatever `find_tools` has already
   revealed in this conversation,
3. per-tool **description overrides** from Settings → Tools.

### Where tools are defined

| Source | Where |
|---|---|
| Server tools | `src/lib/assistant/tools/server/*` via `src/lib/assistant/registry.ts` |
| Frontend tools | `src/lib/assistant/tools/frontend-declarations.ts`, executed by `src/components/agent/v2/FrontendToolsV2.tsx` |
| Service tools | A marketplace item with `deploymentMode: "tools"` declares them at startup over worker IPC; they register into the same capability registry at runtime ([Service daemons §15](../apps/services.md#15-services-as-native-assistant-tools-deploymentmode-tools-039-service-tool-exposure)) |

The **capability registry** (`src/lib/agent/capabilities-registry.ts`) is the
single source of truth for tool ids and gating. Tool naming standard:
`subsystem_object_verb`, snake_case, one id per logical operation. A capability
with `context: "both"` is one id exposed on both surfaces (main chat + delegated
sub-agent), e.g. `file_read`.

## Tool groups (041-tool-groups)

Every capability belongs to exactly one group, referenced by a stable group
**id** (a slug). Groups live in `src/lib/agent/tool-groups.ts`: a built-in table
whose order is canonical, plus a `globalThis`-backed dynamic layer that
marketplace items register into when their service starts.

Because the provider's tool field cannot express grouping, the group model
surfaces in the **system prompt** instead, as a `## Tool groups` block built by
`buildToolGroupsBlock()` (`src/lib/agent/instructions.ts`) — the fourth index
block alongside Skills, MCP servers and Knowledge bases. It is built from the
run's GATE, not from an agent record, so named, ephemeral and surface-delegated
agents each get a block matching what they can actually call. Its rules:

- a group appears iff the agent is granted ≥1 tool in it;
- visible tools are listed **by name**; hidden (deferred) tools are only
  **counted**, with a `find_tools(group: "<id>")` line — naming them would
  defeat deferral;
- it never restates a tool's description or schema (the provider already sends
  those), and it is static for the run so the cached system block isn't
  invalidated on every step.

**There is no fallback group.** A capability whose group id doesn't resolve is a
bug that gets surfaced — in Settings → Tools as an "Unresolved tool group" block,
and for a service tool as an error on the owning service. Nothing is bucketed
into a placeholder.

## Discovery — `find_tools`

`src/lib/assistant/tools/server/discovery.ts` is the ONE implementation (two
others existed and were deleted as dead code in 041). It is always available and
never registry-gated. Two modes, combinable:

- `query` — natural-language search, ranked by `src/lib/agent/discovery-search.ts`:
  per-term IDF over tool id / description / curated aliases / group name /
  group description, with stopword removal, suffix folding and a distinct-term
  coverage bonus. Pure and deterministic, so it is unit-testable
  (`tests/agent/discovery-search.test.ts`, including a committed
  natural-language benchmark).
- `group` — returns every hidden tool of a group, **uncapped**. `maxFindResults`
  applies to free-text only.

It never returns an empty result silently: an unknown group, a query that
matches nothing, and an unsearchable query each come back with an explanation
and the agent's own group index. Truncation is always reported.

**Results carry no JSON schema.** Returning a tool already un-gates it into the
provider's native tool field on the next step, where the model gets its real
schema — so copying the schema into the tool result duplicated data nothing
reads back. Results carry id, description, group and why they matched.

`find_tools` does NOT reach MCP server tools; those go through the MCP gateway
(`mcp_tool_search` → `mcp_tool_schema` → `mcp_tool_call`).

### How "revealed" works

There is no reveal store. The revealed set is re-derived from the transcript on
every step by `deriveRevealedIds` (`src/lib/assistant/messages.ts`, mirrored in
`src/lib/agent/tool-gate.ts`), which reads ids out of prior `find_tools` tool
results. Two things about it are load-bearing:

- it accepts BOTH the pre-041 bare-array payload and the current envelope,
  permanently — transcripts are replayed from disk and never rewritten;
- it reads the **canonical** transcript, not the compacted model view. Compaction
  clears older tool results from what the model sees while the reveal must
  survive. Pointing it at `contextMessages` would silently un-reveal tools
  mid-conversation.

## The Tools panel

`src/lib/agent/tool-manifest.ts` (`assistantToolsManifest()`) is a display-only
view of the capability registry, rendered in the Assistant's right **Tools**
panel. It is built per call from `listCapabilities()` so a marketplace item's
service tools appear and disappear with its service.

---

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
  `src/lib/files/serve.ts` — **change both together**, or the tool claims a
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

## Adding a tool (recipe)

1. Implement it. A **server** tool goes in `src/lib/assistant/tools/server/<area>.ts`
   and is spread into `assistantTools()` in `src/lib/assistant/registry.ts`. A
   **frontend** tool is declared in `tools/frontend-declarations.ts` and handled
   in `components/agent/v2/FrontendToolsV2.tsx`.
2. Add a capability to `src/lib/agent/capabilities-registry.ts` with the same id,
   the right `context`, and a **group id** from `tool-groups.ts`. Add `aliases`
   for vocabulary a user would plausibly use that your description doesn't
   contain — that is what makes the tool findable by natural language.
3. If it belongs to a genuinely new family, add the group to
   `BUILTIN_TOOL_GROUPS` in `tool-groups.ts` (id, display name, a real
   one-line description, aliases) and place it in the table where it should
   appear — that array's order is the display order everywhere.
4. Prefer extending an existing group over inventing one. A group with two tools
   is noise in the system-prompt index.

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
