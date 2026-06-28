# MCP integration

BOS connects to **MCP (Model Context Protocol)** servers and exposes their tools to
the assistant through a **gateway** (progressive disclosure) — it does NOT dump every
server's tools into the request. Modules: `src/lib/mcp/`. See `specs/014-mcp-tool-gateway/`.

---

## Types & transports (`src/lib/mcp/types.ts`)

`McpServerConfig` is keyed by **`name`** (unique). Fields:
`{ name, description?, transport?, endpoint?, apiKey?, headers?, command?, args?, env?, cwd? }`.
`description` is the index shown to the agent (see Gateway). `McpToolDescriptor`
(`{ server, name, description?, schema? }`) is one tool as surfaced by discovery.
Three transports:

- **`http`** — streamable‑HTTP. `endpoint` (URL); optional `apiKey` (sent as
  `Authorization: Bearer …`) and `headers` (arbitrary custom headers, e.g.
  `Private-Token`; custom headers win over the bearer one).
- **`sse`** — server‑sent events. Same fields as `http`.
- **`stdio`** — a local spawned process: `command` + `args` + `env` + `cwd`
  (e.g. `command: "docker"`, `args: ["run","-i","--rm", …]`). Older configs that
  packed a command line into `endpoint` still work (parsed as a fallback).

---

## Store (`src/lib/mcp/store.ts`, server‑only)

Persists the server list at `data/mcp-servers.json`
(`listMcpServers`/`addMcpServer`/`removeMcpServer`), **keyed by `name`** (add is an
upsert by name; remove takes a name). Seeded from `BOS_MCP_SERVERS`
(comma‑separated endpoints) on first use.

---

## Client (`src/lib/mcp/client.ts`)

Wraps `@modelcontextprotocol/sdk`: `connectMcpClient` (right transport, with custom
headers / stdio command+args), `extractText` (text + MCP‑UI passthrough), and
`probeMcpServer` (used by the MCP panel status and the Settings **Test** button).
Designed to **degrade gracefully** — an unreachable server yields an error for that
server rather than failing the chat.

---

## Gateway (`src/lib/mcp/gateway.ts`)

How the agent actually uses MCP tools (014). Instead of injecting tools, the agent
gets a tiny fixed tool set and the per‑server **descriptions** in its instructions
(`composeInstructions` injects an index of the agent's *allowed* servers). The
gateway provides three operations, all enforcing the agent's allowlist (`011`):

- `findTools(query, agentId?)` — search tool name+description across allowed servers
  (v1 matcher = wildcard/substring via `makeToolMatcher`, isolated so semantic
  search can replace it; returns `McpToolDescriptor[]` with schemas).
- `listServerTools(server, agentId?)` — one server's tools, with schemas.
- `callServerTool(server, tool, args, agentId?)` — execute, reusing
  `connectMcpClient` + `extractText` (MCP‑UI passthrough). Per‑server tool lists are
  cached briefly (TTL) so repeated find/list/call don't reconnect each time.

Exposed at **`/api/mcp/tools`** (GET `?server=` / `?find=`; POST `{server,tool,args}`)
and to the agent as `findTools` / `listMcpServerTools` / `callMcpServerTool`
(`McpActions.tsx`, which threads the chat's `agentId` for scoping).

## Runtime wiring (`src/lib/agent/runtime.ts`)

`buildRuntimeOptions()` does **not** inject user‑configured MCP servers (the gateway
handles those). It injects **only** the managed browser‑automation server (when
enabled — see [Browser automation](../automation/browser-automation.md)), a small
curated tool set. Note: CopilotKit 1.61 only fetches MCP tools when the runtime is
given an `actions` array (`handleServiceAdapter → getToolsFromMCP`), so it passes
`actions: []` to enable that path for the automation server. (This is the gate that
previously left the chat with **no** MCP tools at all.)

---

## MCP-UI (`src/lib/mcp/ui.ts`)

Helpers to detect and render **MCP‑UI** results — tools that return interactive
HTML. `ChatToolRenderer` shows these in a **sandboxed iframe** in the chat.

---

## HTTP (`/api/mcp`)

- **GET** → `{ servers }`; **GET `?probe=<name>`** → `{ result: { ok, tools?, error? } }`
  (probes a saved server by name).
- **POST** body = a full `McpServerConfig` → upsert (validated per transport).
  With `{ test: true, … }` it **probes the given config without saving** — this is
  what the Settings "Test connection" button uses.
- **DELETE `?name=<name>`** removes (also accepts `?endpoint=` for back‑compat).

Config UI: **Settings → MCP Servers** (`src/components/apps/settings/McpServersTab.tsx`,
registered as the `mcp` namespace) — CRUD for all three transports, a **Description**
field, custom headers/env editors, a **Test** button, and JSON import. Agent actions
(`McpActions.tsx`): management — `listMcpServers` / `addMcpServer` / `removeMcpServer`;
usage (the gateway) — `findTools` / `listMcpServerTools` / `callMcpServerTool`. The MCP
panel (`InfoPanel.tsx`) lists servers and probes each for live status.
