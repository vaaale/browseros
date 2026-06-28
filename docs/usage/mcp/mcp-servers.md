# MCP servers

BOS supports **MCP (Model Context Protocol)** servers — external tool providers
the assistant can use. Rather than loading every server's tools into the
assistant at once (a single server can expose 100+ tools), BOS shows the
assistant a short **description of each server** and lets it **discover and call**
tools on demand — so adding big servers doesn't slow the chat or confuse the model.

---

## Seeing connected servers

The Assistant's right‑hand **MCP** tab lists configured servers and shows a live
status for each:

- **connected** — reachable and exposing tools.
- **disconnected** — not currently reachable.
- **checking** — being probed.

---

## Configuring servers (Settings → MCP Servers)

Open **Settings → MCP Servers** to add, edit, test, and remove servers. Each
server has a unique **name**, a short **description** (what it's for — this is what
the assistant sees, so write it for the agent, e.g. "Tools to interact with
GitLab"), and one of three **transports**:

- **Streamable HTTP** — a server URL. Optionally add a **bearer token** and/or
  arbitrary **custom headers** (e.g. `Private-Token: …`).
- **SSE** — a server URL using server‑sent events (same token/header options).
- **stdio** — a **local process** BOS spawns. Give a **command**, **arguments**
  (one per line), optional **environment variables**, and a working directory.
  For example, the GitHub MCP server via Docker:
  - command: `docker`
  - args: `run`, `-i`, `--rm`, `-e`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `ghcr.io/github/github-mcp-server`
  - env: `GITHUB_PERSONAL_ACCESS_TOKEN = ghp_…`

Click **Test connection** to verify a server and list the tools it exposes
*before* saving. You can also paste a standard MCP JSON config via **Import from
JSON**.

Per‑agent access (which agents may use which servers) is set under
**Settings → Assistant**.

## How the assistant uses them

You don't pick tools — just ask for what you want (e.g. *"Use gitlab and list my
projects"*). Behind the scenes the assistant:

1. reads the server **descriptions** to pick the right server,
2. **discovers** the tool — `findTools` (search across all servers) or
   `listMcpServerTools` (one server), which return each tool's arguments, then
3. **calls** it with `callMcpServerTool`.

It can also **add / remove / list** servers on request (e.g. *"Add an MCP server
at `https://my-tools.example.com/mcp`"*). Connections are **resilient**: an
unreachable server reports an error for that server rather than failing the chat.

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
