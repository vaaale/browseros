# MCP integration

BOS connects to **MCP (Model Context Protocol)** servers and auto‑exposes their
tools to the assistant. Modules: `src/lib/mcp/`.

---

## Types & transports (`src/lib/mcp/types.ts`)

`McpServerConfig` = `{ id, name, endpoint, transport, command?, args?, env? }`.
Three transports:

- **`http`** — streamable‑HTTP (a URL).
- **`sse`** — server‑sent events (a URL).
- **`stdio`** — a local spawned command (`command` + `args` + `env`).

---

## Store (`src/lib/mcp/store.ts`, server‑only)

Persists the chat server list at `data/mcp-servers.json`
(`listServers`/`addServer`/`removeServer`). Seeded from `BOS_MCP_SERVERS`
(comma‑separated endpoints) on first use.

---

## Client (`src/lib/mcp/client.ts`)

Wraps `@modelcontextprotocol/sdk`: connects with the right transport, lists tools,
and **probes** a server (used by the MCP panel's status and the `probeMcpServer`
action). Designed to **degrade gracefully** — an unreachable server yields no tools
rather than failing the chat.

---

## Runtime wiring (`src/lib/agent/runtime.ts`)

`buildRuntimeOptions()` collects the configured chat servers **plus** the managed
browser‑automation server (when enabled — see
[Browser automation](../automation/browser-automation.md)) and passes them to the
CopilotKit runtime so their tools appear automatically in `/api/copilotkit`.

---

## MCP-UI (`src/lib/mcp/ui.ts`)

Helpers to detect and render **MCP‑UI** results — tools that return interactive
HTML. `ChatToolRenderer` shows these in a **sandboxed iframe** in the chat.

---

## HTTP (`/api/mcp`)

- **GET** → `{ servers }`; **GET `?probe=<endpoint>`** → `{ result: { ok, tools? } }`.
- **POST** add; **DELETE** remove.

Client actions: `listMcpServers`, `addMcpServer`, `removeMcpServer`,
`probeMcpServer` (`McpActions.tsx`). The MCP panel (`InfoPanel.tsx`) lists servers
and probes each for live status.
