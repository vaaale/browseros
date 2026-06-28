# Feature Specification: MCP Tool Gateway (progressive disclosure)

**Feature Branch**: `014-mcp-tool-gateway`

**Created**: 2026-06-28

**Status**: Draft

**Input**: "Don't dump every MCP server's tools into every request. Put a short per-server **description** in context, and give the agent gateway tools to **discover** (search/list, with schemas) and **call** MCP tools on demand. Start with simple wildcard search; allow semantic search later."

> Supersedes the naive fix discussed for the MCP bug. Today MCP tools never reach the chat model at all: CopilotKit 1.61 only fetches them inside an `if (this.params.actions)` branch (`getToolsFromMCP`), and BOS's `buildRuntimeOptions` passes `mcpServers`/`createMCPClient` but no `actions`, so the branch is skipped (see the trajectory in `c-mqy98bnjwu2r.json`: the agent could `listMcpServers`/`probeMcpServer` but had no `list_projects` to call). The obvious fix — pass `actions: []` so the branch runs — would attach the **full tool set of every allowed server to every request** (the default Assistant would get the dev-harness tools plus ~100 gitlab-mcp tools each message), re-fetched per request because the runtime is rebuilt per POST. That bloats context, slows turns, confuses the (local) model, and doesn't scale. This feature replaces bulk injection with a **gateway**: server descriptions as an index + a fixed, tiny set of discover/call tools. Builds on the MCP config (name-keyed servers, transports, headers, Test) and per-agent scoping (`011`).

## Clarifications

### Session 2026-06-28

- Q: Expose MCP tools as first-class functions (register a server's tools after the agent "activates" it), or wrap them behind a gateway tool? → A: **Wrap them.** CopilotKit assembles a static tool list per request; first-class exposure would require stateful, per-thread dynamic registration the framework doesn't do cleanly, can't add tools mid-turn (the "available on the next message" gap that already confused the local model), and re-introduces the bloat the moment a server is activated. A fixed gateway keeps the tool surface constant and tiny regardless of how many servers/tools exist.
- Q: What does the index in context contain? → A: A concise **per-server description** (user-editable in Settings, with a sensible default when empty) — NOT the tools.
- Q: What does discovery return? → A: Tool **name + description + input JSON schema** (so the model can build correct arguments for the call tool). Names alone are not enough.
- Q: How does `findTools` match in v1? → A: Case-insensitive **wildcard/substring (or simple regex)** over tool name + description across the agent's allowed servers. The matcher MUST be isolated behind one function so it can be swapped for semantic search later without changing the tool contract.
- Q: What happens to CopilotKit's runtime MCP injection? → A: **Dropped for chat tools.** The gateway (BOS frontend actions + a server route) is the sole path for the agent to use MCP tools; `mcpServers`/`createMCPClient` is no longer relied on for the chat.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Use a tool from a big MCP server without context bloat (Priority: P1)

A user asks the assistant to do something a configured MCP server can do (e.g. "list all GitLab projects"). The agent discovers the right tool and calls it — without ever having hundreds of tools in its context.

**Acceptance Scenarios**:

1. **Given** a `gitlab-mcp` server exposing ~100 tools, **When** the user asks to list projects, **Then** the agent calls `findTools`/`listMcpServerTools` to locate the tool, then `callMcpServerTool("gitlab-mcp", "list_projects", …)`, and returns the result.
2. **Given** N configured servers, **When** any chat request is made, **Then** the agent's request tool list contains only the fixed gateway tools (plus BOS's own actions) — its size does not grow with the number of MCP servers or their tools.

### User Story 2 - Steer the agent with server descriptions (Priority: P1)

A user writes a short description per MCP server in Settings so the agent knows what each is for.

**Acceptance Scenarios**:

1. **Given** a server described "tools to interact with GitLab", **When** the user asks a GitLab-ish question, **Then** that description is in the agent's context and the agent drills into that server.
2. **Given** a server with no description, **When** it is in context, **Then** BOS shows a sensible default (e.g. derived from name/transport) rather than nothing.

### User Story 3 - Search across all available tools (Priority: P1)

The agent can search tools across every server it's allowed to use.

**Acceptance Scenarios**:

1. **Given** several servers, **When** the agent calls `findTools("repo")` (or `findTools("list_*")`), **Then** it gets matching tools across allowed servers, each with server, name, description, and input schema.

### User Story 4 - Scoped agents only see their servers (Priority: P2)

**Acceptance Scenarios**:

1. **Given** an agent allowed only `gitlab-mcp` (per `011`), **When** it calls `findTools`/`listMcpServerTools`, **Then** only `gitlab-mcp` tools appear; **and** `callMcpServerTool` on a disallowed server is rejected.

### Edge Cases

- An unreachable/erroring server MUST yield a clear error for *that* server (in find/list/call) and never break the chat or other servers' results.
- A tool name that exists on two servers is disambiguated by the required `server` argument on `callMcpServerTool` (and `findTools` results carry their server).
- The discover/call tools render as ordinary tool-call cards in the chat, with MCP-UI results passing through unchanged.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: BOS MUST NOT bulk-inject MCP server tools into the chat request's tool set. The agent instead gets a **fixed, small set of gateway tools** plus a per-server **description index**; the request tool count MUST be independent of how many servers/tools are configured.
- **FR-002**: Each MCP server MUST have an optional, user-editable **`description`** (Settings → MCP Servers, persisted in the server config). The descriptions of the active agent's **allowed** servers MUST be injected into the agent's composed instructions as a concise index (name → description). When a description is empty, BOS MUST supply a sensible default.
- **FR-003**: The agent MUST have **`listMcpServerTools(server)`** returning, for that server, each tool's **name, description, and input JSON schema**.
- **FR-004**: The agent MUST have **`callMcpServerTool(server, tool, args)`** that executes the named tool server-side (reusing the existing MCP client + result extraction, so text and MCP-UI results pass through) and returns its result, with a clear error when the server/tool is unknown, disallowed, or unreachable.
- **FR-005**: The agent MUST have **`findTools(query)`** that searches across the active agent's **allowed** servers and returns matches as `{ server, name, description, schema }`. v1 matching MUST be case-insensitive **wildcard/substring (or simple regex)** over name + description. The matching function MUST be isolated so it can later be replaced by semantic search **without changing the tool's contract**. (v1 scope = MCP tools; built-in BOS actions are already first-class. The result shape MUST allow other sources later.)
- **FR-006**: All gateway tools MUST enforce the active agent's MCP **server allowlist** (`011`): disallowed servers are invisible to `findTools`/`listMcpServerTools` and rejected by `callMcpServerTool`.
- **FR-007**: BOS MUST stop relying on CopilotKit's runtime MCP injection (`mcpServers`/`createMCPClient`) for **chat** tools; the gateway is the sole path. Any non-chat dependency on that path (e.g. the managed browser-automation server) MUST be preserved by other means or explicitly migrated.
- **FR-008**: Discovery MUST be efficient: per-server tool lists (name/description/schema) SHOULD be **cached server-side with a short TTL** and invalidated on config change, so repeated `findTools`/`listMcpServerTools`/`callMcpServerTool` within a short window don't reconnect every time. Connections MUST stay resilient (one bad server never breaks the chat).
- **FR-009**: The gateway tools MUST be available to both the main Assistant chat and embedded chats (`012`), and MUST appear in the assistant's tool catalog/InfoPanel and `tool-manifest.ts`.

### Key Entities

- **MCP server** — now also carries a `description`.
- **MCP tool descriptor** — `{ server, name, description, schema }` (the unit returned by discovery).
- **Gateway tools** — `findTools`, `listMcpServerTools`, `callMcpServerTool`.
- **Tool matcher** — the pluggable function behind `findTools` (wildcard now, semantic later).
- **Server description index** — the name→description block injected into agent instructions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With one server exposing ~100 tools (plus others), the chat request's tool list stays constant and small (the gateway tools) — it does not grow with server/tool counts.
- **SC-002**: "List all GitLab projects" results in the agent discovering and calling the correct tool via the gateway and returning real results.
- **SC-003**: A server description set in Settings appears in the agent's context and steers it to the right server.
- **SC-004**: `findTools` returns schema-bearing matches across allowed servers for a wildcard query.
- **SC-005**: An agent scoped to a subset of servers cannot discover or call tools on disallowed servers.
- **SC-006**: Repeated discovery/calls within the cache window do not reconnect to every server each time; an unreachable server degrades gracefully (clear per-server error, chat unaffected).

## Assumptions & Dependencies

- Builds on the MCP configuration (name-keyed servers; streamable-http/SSE/stdio; custom headers; Test) and reuses `connectMcpClient`/`extractText` (`src/lib/mcp/`).
- Depends on per-agent capability scoping (`011`) for the server allowlist; complements core `FR-017` (MCP config UI) — this feature adds the per-server Description field and changes how tools reach the agent.
- Supersedes the rejected `actions: []` approach; removes the CopilotKit runtime MCP injection for chat.
- Out of scope (v1): semantic search (matcher is pluggable for it later); per-tool allowlisting and "pinning" frequently-used tools as first-class (possible later ergonomics).
