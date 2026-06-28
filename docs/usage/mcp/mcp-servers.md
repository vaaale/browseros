# MCP servers

BOS supports **MCP (Model Context Protocol)** servers — external tool providers
the assistant can connect to. Connecting an MCP server makes its tools available
to the assistant automatically, alongside BOS's built‑in actions.

---

## Seeing connected servers

The Assistant's right‑hand **MCP** tab lists configured servers and shows a live
status for each:

- **connected** — reachable and exposing tools.
- **disconnected** — not currently reachable.
- **checking** — being probed.

---

## Connecting a server

Ask the assistant to manage MCP servers — it has tools to **list**, **add**,
**remove**, and **probe** (test) servers. For example:

> "Add an MCP server at `https://my-tools.example.com/mcp`."

> "Probe the tools server and tell me what tools it exposes."

BOS supports three transports:

- **HTTP (streamable)** — a server URL.
- **SSE** — a server URL using server‑sent events.
- **stdio** — a local command BOS spawns (e.g. a CLI MCP server).

Connections are **resilient**: if a server is unreachable, the assistant simply
gets no tools from it rather than failing the whole chat.

---

## MCP‑UI (interactive results)

Some MCP tools return **interactive HTML** ("MCP‑UI") instead of plain text. BOS
renders these in a **sandboxed frame** right in the chat, so a tool can present a
small interactive panel as its result.

---

## Related: browser automation

Browser automation is delivered **through MCP** — when you enable it, BOS runs a
managed Playwright MCP server and its browser tools appear to the assistant like
any other MCP tools. That feature has its own safety settings; see
[Browser automation](../settings/browser-automation.md).
