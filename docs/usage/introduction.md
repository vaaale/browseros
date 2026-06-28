# Introduction to BrowserOS

BrowserOS (BOS) is an agentic "operating system" that runs entirely in your web
browser. It has a **desktop**, a **dock**, draggable **windows**, a set of
built‑in apps, and — at its center — an **AI assistant** that can operate the OS
for you: open apps, manage files, browse the web, change settings, connect tools,
build brand‑new apps, and even modify BOS itself.

This section is for **using** BOS. If you want to extend or change how BOS works,
see the developer documentation under `docs/dev/`.

---

## What makes BOS different

- **An assistant that can do almost anything in the OS.** You talk to it in
  plain language and it takes real actions through tools (opening apps, editing
  files, changing settings, …).
- **It builds and changes software for you.** Ask it to "build a pomodoro timer"
  and a new app appears on your desktop. Ask it to "add a dark‑mode toggle to
  Settings" and it edits BOS's own code on a safe branch.
- **It learns over time.** BOS keeps a curated **memory** of who you are and what
  it has learned, and a library of **skills** (reusable procedures) that improve
  from your feedback.
- **It can safely run multiple versions of itself.** When BOS changes its own
  code, it can preview a candidate version and promote or discard it without
  taking down the running system.

---

## First run

The first time you open BOS, a **setup wizard** appears. It collects three things
(all changeable later in **Settings**):

1. **AI Provider** — which model powers the assistant. Choose a provider
   (**Anthropic**, **OpenAI**, **OpenAI Codex**, or a **local OpenAI‑compatible**
   server), a model, an optional base URL, and an API key. Local/self‑hosted
   models that speak the OpenAI API are supported (and usually need no key).
2. **Claude Dev Harness** (optional) — how the assistant runs *Claude Code* for
   development tasks. The default, **Claude CLI (headless)**, runs Claude Code on
   the machine hosting BOS. You can also point it at an MCP harness.
3. **Data Isolation** — how a previewed BOS version's data is kept separate from
   your live data during self‑modification. The wizard defaults to the best method
   your filesystem supports.

You can **Skip** the wizard, but the assistant cannot respond until an AI provider
is configured.

> The wizard reappears only until you finish (or skip) it once. Re‑run any of these
> choices anytime from **Settings**.

---

## The desktop at a glance

- **Desktop icons** (top‑left): double‑click to open an app.
- **Top bar**: OS status and — when BOS runs under the Supervisor — the version
  controls for previewing/promoting BOS versions.
- **Dock** (bottom): launch or focus apps.
- **Windows**: drag the title bar to move, drag the bottom‑right corner to resize,
  double‑click the title bar to maximize. The three buttons close, minimize, and
  maximize. Click a window to bring it to the front.

Some apps are **singletons** (Assistant, Memory, Docs, Settings) — opening them
again just focuses the existing window.

---

## Built‑in apps

| App | What it's for |
|---|---|
| **Files** | Browse and edit your personal files (the virtual file system). |
| **Browser** | View external web pages inside BOS through a built‑in proxy. |
| **Assistant** | Chat with the BOS agent — the heart of BOS. |
| **Memory** | Review and edit what the assistant remembers about you. |
| **Docs** | Read the BrowserOS documentation inside the OS. |
| **Settings** | Configure everything: provider, appearance, skills, agents, apps, … |

Apps you (or the assistant) install later — like **Workflow Manager** — appear
alongside these.

---

## Where to go next

- **[The desktop, windows, and dock](desktop/desktop-windows-and-dock.md)** — the shell.
- **[Using the Assistant](assistant/using-the-assistant.md)** — chat, panels, and live activity.
- **[How memory works](memory/how-memory-works.md)** — what BOS remembers and why.
- **[Self‑improvement](self-improvement/learning-from-experience.md)** — how BOS gets better over time.
- **[Building & modifying things](building-and-modifying/building-apps.md)** — apps and BOS changes.
- **[Settings](settings/overview.md)** — every configuration tab.
- **[Live version control](versions/live-version-control.md)** — previewing and promoting BOS versions.
