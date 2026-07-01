# Assistant

The **Assistant** app is the chat where you talk to the BOS agent. It's the most
important app in BOS — the assistant can operate the whole OS for you.

This page is a quick tour. For the full guide, see the **Assistant** section:

- **[Using the Assistant](../assistant/using-the-assistant.md)** — the chat, the
  conversations panel, the Tools/Skills/MCP panel, and how live activity is shown.
- **[Agents & personalities](../assistant/agents-and-personalities.md)** — choosing
  and editing the assistant's personality.
- **[Delegation & sub‑agents](../assistant/delegation-and-sub-agents.md)** — how the
  assistant farms work out to specialist sub‑agents (and when it uses Claude).

---

## The layout

The Assistant window has three areas:

- **Left — Conversations.** Start a new conversation, switch between them, or
  delete one. Each conversation is its own thread and is saved to your files.
- **Center — Chat.** Type requests in natural language. The assistant streams its
  work live as collapsible cards (thinking, tool calls, sub‑agent activity). A
  **Working… / Ready** indicator shows whether it's busy.
- **Right — Tools / Skills / MCP.** Three tabs showing what the current agent can
  do, the skills it has, and the MCP servers it's connected to.

You can collapse the left and right panels with the buttons in the chat header.

---

## What it can do

Almost anything in BOS, including:

- Open and arrange apps, change the wallpaper, open web pages.
- Read and write your files.
- Change any setting.
- Connect MCP servers and use their tools.
- Search the web for current information when Anthropic is the configured AI provider.
- **Build a new app** from a description, and install it to your desktop.
- **Modify BOS itself** (edit the OS's own code, safely on a branch).
- Remember durable facts and improve its own skills.

If no AI provider is configured, the chat shows a banner with a shortcut to open
**Settings**.

## Web Search

The assistant can search the web for current, source-backed information through
Anthropic native web search. Ask naturally, for example: "search the web for the
latest Next.js release notes and summarize the breaking changes."

Notes:

- Web search currently works only when the AI provider is Anthropic and an Anthropic
  API key is configured.
- For answers based on web search, the assistant should cite the source URLs it used.
- If you already know the page URL, the assistant may use its existing `web_fetch`
  ability instead of running a search.
