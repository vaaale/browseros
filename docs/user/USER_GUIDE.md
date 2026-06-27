# BrowserOS — User Guide

BrowserOS (BOS) is an agentic "operating system" that runs entirely in your web browser. It has a desktop, a dock, draggable windows, and a built-in AI assistant that can operate the OS for you — open apps, manage files, browse the web, change settings, and even build new apps or modify BOS itself.

This guide is for **using** BOS. If you're extending or modifying BOS, see `docs/DEVELOPMENT.md`.

---

## First run

The first time you open BOS, a **setup wizard** appears. It asks for:

1. **AI Provider** — which model powers the assistant. Choose a provider (Anthropic, OpenAI, OpenAI Codex, or a local OpenAI‑compatible server), a model, an optional base URL, and an API key. Local/self‑hosted models that speak the OpenAI API are supported.
2. **Dev Harness** — how the assistant runs *Claude Code* for development tasks. The default, **Claude CLI (headless)**, runs Claude Code on the machine hosting BOS. You can also point it at a remote harness. (You can skip this and set it later.)

You can change all of this anytime in **Settings**. If you skip the wizard, the assistant won't be able to respond until an AI provider is configured.

---

## The desktop

- **Desktop icons** (top‑left): double‑click to open an app.
- **Top bar**: shows the OS status / menu area.
- **Dock** (bottom): open apps and quick launchers; click to focus or launch.
- **Windows**: drag the title bar to move, drag the bottom‑right corner to resize, double‑click the title bar to maximize. The three buttons (red/yellow/green) close, minimize, and maximize. Click a window to bring it to the front.

Some apps are **singletons** (only one window at a time) — opening them again just focuses the existing window.

---

## Built‑in apps

### Files
A browser for your **virtual file system** (VFS) — your personal, sandboxed storage (Documents, Pictures, Desktop, …). Create folders, read and write text files, rename, and delete. This is *your* data; it is separate from BrowserOS's own program files.

### Browser
A web browser that loads external pages through a built‑in proxy so they render inside BOS. Type a URL or search. Note the out‑of‑scope cases below.

### Assistant
The chat where you talk to the BOS agent. See **Using the Assistant** below — it's the heart of BOS.

### Memory
Shows what the assistant has learned and remembered over time (durable facts, preferences, lessons). You can review and remove memories here.

### Docs
The in‑OS documentation hub — user‑friendly help pages. The assistant keeps these updated as features change.

### Settings
Configure BOS. See **Settings** below.

---

## Using the Assistant

Open **Assistant** from the desktop or dock. The window has three areas:

- **Left panel — Conversations**: start a new conversation, switch between conversations, or delete one. Each conversation is its own thread.
- **Center — Chat**: type requests in natural language. The assistant streams its work live — you'll see *thinking*, *tool calls*, and *sub‑agent* activity as collapsible cards. A busy/ready indicator shows whether it's working.
- **Right panel — Tools / Skills / MCP**:
  - **Tools**: the actions the assistant can take (open apps, file operations, settings, etc.).
  - **Skills**: reusable procedures the assistant can follow (and that it creates as it learns).
  - **MCP**: connected MCP servers and their status (connected / disconnected).

### What the assistant can do
Almost anything in BOS, including:
- Open and arrange apps, change the wallpaper, open web pages.
- Read and write your files.
- Change any setting.
- Connect MCP servers and use their tools.
- **Build a new app** from a description ("build me a pomodoro timer") — it appears on your desktop.
- **Modify BOS itself** ("add a dark/light toggle to Settings", "change how the Skills page looks") — it edits the OS's own code.
- Remember things for later and improve its own skills.

### How it works (so the activity cards make sense)
The assistant **delegates** real work to **sub‑agents**:
- **Local sub‑agents** (your configured model) handle general tasks like research or writing.
- **Claude sub‑agents** handle **all development/coding** — building apps and changing BOS. These run Claude Code.

If the assistant wants to use a Claude (Claude Code) agent for a *non‑development* task, it will ask permission first with a card offering **Allow once**, **Allow this session**, or **Use Local**.

When the assistant builds an app or changes BOS, it works on a separate copy (a git "feature branch") so changes are safe and reversible, and it updates the documentation afterward.

### Personalities (agents)
The assistant's personality is defined by an **agent**. Pick the active agent from the selector in the chat header; manage agents — switch the active one, edit its instructions, or create new ones — in **Settings → Assistant**. These are the same agents the assistant delegates work to.

### Rich responses
The chat renders Markdown, code blocks, and inline HTML previews (sandboxed). Some MCP tools can return interactive "MCP‑UI" panels, also rendered safely in a sandbox. You can select and copy text anywhere in the chat, editors, and docs.

---

## Settings

Settings is organized into tabs. Apps and features can add their own tabs.

- **Assistant** — manage agents and choose which one is the active personality.
- **Skills** — your skill library. Click a skill to open its editor and change its **main file** (name, description, "when to use", and the instructions), plus any attached **scripts** and **references**. You can create and delete skills here too.
- **Apps** — manage installed apps:
  - **Uninstall** — hides the app from the desktop but **keeps its files**, so you can restore it later.
  - **Restore** — brings an uninstalled app back.
  - **Purge** — permanently deletes the app's files.
- **Appearance** — wallpaper (presets, an image URL, or a VFS image path), fit (cover/contain), and accent color, with a live preview.
- **AI Provider** — provider, model, base URL, API key, **max output tokens**, and **context window**. Your API key is never shown back in plaintext. Use **Test connection** to verify it works.
- **Dev Harness** — how Claude Code runs for the developer agent: **Claude CLI (headless)** (default, runs on the host), or an MCP harness (local `claude mcp serve`, or a remote HTTP/SSE server). **Test** checks availability.

### A note on reasoning ("thinking") models
If you use a reasoning model (DeepSeek/Qwen‑style) that "thinks" before answering, make sure **max output tokens** is large enough — the model spends tokens on hidden reasoning before producing a final answer, and a small cap can yield an empty reply. BOS surfaces the reasoning stream as a "thinking" card.

---

## Building & changing things, in practice

- **"Build an app that …"** → the assistant has a Claude developer agent generate a self‑contained app and installs it; an icon appears on the desktop.
- **"Change/fix/redesign <some BOS feature>"** → the assistant delegates to the developer agent, which edits BOS's own source. Changes usually appear live (the dev server hot‑reloads). Some changes (new dependencies, server config) may require a restart — the assistant will say so.
- **"Uninstall / remove that app"** → it's hidden but its files are kept; purge it from **Settings → Apps** to delete for good.

---

## Limits & things to know

- **Web browser scope**: the proxy is for normal web pages. **Out of scope**: DRM/streaming video sites and WebSockets.
- **Development needs Claude**: building apps and modifying BOS are done by Claude Code, not your local model. If the Dev Harness isn't configured/available, the assistant will tell you instead of doing it some other way.
- **Cost**: development tasks run a real Claude Code session and consume Claude usage/credits. Larger changes cost more.
- **Privacy**: your files live in BOS's virtual file system on the host; the assistant can read/write there when you ask it to.
