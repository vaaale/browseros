We are going to write a single-page BrowserOS using nodejs and nextjs. The os must use server-side rendering.
We will use gitlab which is already configured (cloned).
Below is a description of the initial requirements of the Browser OS (BOS from here on):

# Basic functionality
The os must have a file browser and web browser.
It must be possible to change the wallpaper

The web browser renders external pages through a **same-origin, path-based rewriting proxy** (e.g. `/api/proxy/<scheme>/<host>/<path>`) so pages load inside the OS without cross-origin (CORS) errors or module MIME errors:
- Use a path-based proxy URL (not a `?url=` query) so the browser's own relative-URL resolution — including ES module imports — maps back onto the proxy instead of the OS origin.
- Rewrite HTML (`src`/`href`/`action`/`poster`), CSS (`url()`/`@import`), and inject a small runtime shim that re-routes the page's dynamic `fetch`/XHR through the proxy. Strip page CSP/`<base>`.
- Disable trailing-slash redirects for proxy paths (a redirect that strips the slash breaks the relative base).
- Out of scope: DRM/streaming media (e.g. video sites) and WebSockets.

# Agentic behavior and automation
The os must have a built-in chat to talk to the BOS agent.
The agent must support MCP servers
The chat must use copilotkit (https://www.copilotkit.ai/)

# Configuration
BOS must provide functionality that apps and features can use to hook into the configuration system.
For example, an app should be able to add a tab / page to the configuration app for the user to configure itself.
This should also be exposed as tools to the assistant automatically.

The Settings app renders one tab per registered configuration namespace. A feature/app registers a tab by adding a config schema (fields, or a custom component); the same schema is auto-exposed to the assistant as configuration tools. Built-in tabs:
- **Assistant** — manage agents and select which one is the active personality.
- **Skills** — browse and edit the assistant's skill library (see Skills).
- **Apps** — manage runtime-installed apps: uninstall (hides the app but keeps its files), restore an uninstalled app, or purge (permanently delete its files).
- **Appearance** — wallpaper and accent color.
- **AI Provider** — provider, model, API key (masked), base URL, max output tokens, context window.
- **Dev Harness** — how the developer sub-agent runs Claude Code (see Developer sub-agent).

## Configuring models and providers
It must be possible to configure the AI providers such as OpenAI, OpenAI Codex, Anthropic and Local models as OpenAI Compatible.
It must be possible to configure the model, api keys, api base url, **max output tokens**, and **context window (max input tokens)**.
The API key must never be returned to the client in plaintext (masked in the config API).

Reasoning / "thinking" models (e.g. DeepSeek/Qwen-style) must be supported:
- The configured max output tokens must be large enough that the model can finish its hidden reasoning and still emit a final answer (a small cap yields an empty response). Server-side agent loops must use the configured budget, not a small hardcoded value.
- For OpenAI-compatible providers the chat MUST use the Chat Completions API, not the Responses API — many local servers don't implement Responses, which otherwise produces a broken/empty stream.
- A model's `reasoning_content` (reasoning tokens that arrive separately from `content`) must be surfaced to the UI as "thinking", not dropped — otherwise the chat sees no content during the reasoning phase and aborts.

# Assistant
BOS must support multiple agents that can serve as the assistant's personality.
The "Assistant" app must have a way for the user to select which agent (personality) he wants to use.
The Assistant must be able to do basically anything in BOS. This includes building new apps or BOS features, configuring settings, opening apps, etc.
The assistant must always delegate tasks to a sub agent. If an appropriate sub-agent does not exist, the assistant must create one. See Sub agents below.
When the assistant is working, events such as reasoning / thinking, tool calls / tool responses, etc. must be shown in the UI. The events must be rendered using an appropriate card. The cards must be collapsible. When an event is received, the corresponding card should be shown expanded. After a certain amount of time or when a new event is received, the card should collapse so that only the heading of the event is visible in the UI. The heading should be derived from the type of event.
Events must be **streamed live as they occur** (not batched and shown only when the task finishes) — this includes events produced by sub-agents during delegation. The collapse state and its timer must live outside the per-card React lifecycle (e.g. a module-level store), because the chat re-renders/remounts cards while streaming; a per-component timer would be cleared on unmount and never fire. Cards must remain manually toggleable (use a native disclosure so clicks are reliable).
There should be some kind of indicator showing that the agent is working / busy. When the task is complete, the indicator should change so that the user understands that the assistant is done with the task.

## Memory system
The agent must have a self-improving memory system similar to Hermes-Agent.

## Skills
The assistant must have a library of skills (named, on-demand procedures), inspired by Hermes-Agent.
- Each skill is stored as markdown under `data/skills`: either a flat `<id>.md`, or a directory `<id>/` containing `SKILL.md` plus optional `scripts/` and `references/` subdirectories holding asset files. The skill file has frontmatter (name, description, when-to-use, optimizer score) and an instruction body.
- Skills are advertised to the assistant as an index (name + when-to-use); the assistant loads a skill's full body (and may consult its scripts/references) on demand before following it.
- The **Settings → Skills** tab is a full editor: it lists all skills; clicking a skill opens a detail page to edit the main skill file (name / description / when-to-use / content) and to add, edit, rename, or remove its scripts and references. Skills can also be created and deleted.
- The out-of-the-box **Develop in BrowserOS** skill covers the two development use-cases via separate references: `building-apps.md` (build and install a new standalone app) and `modifying-bos-features.md` (change BOS itself). Both delegate to the Developer sub-agent (see below). This demonstrates the skill‑with‑references structure (a `SKILL.md` that triages, plus `references/` documents).
Any agent must be configurable using the Settings app.

## Personalities (agents)
There is a single concept of an **agent** — there is no separate "profile". The main assistant's personality is just one of the agents: it adopts the active agent's system prompt (composed with the core policy and the skills index) as its instructions. The user and the assistant can switch the active agent or create new ones. Agents are stored as a directory structure of markdown files under data/agents (see Sub agents); the default **Assistant** agent ships out of the box.

## Task delegation
The agent must delegate to a sub-agent whenever an appropriate sub-agent exists.

## Sub agents
Sub agents in BOS are defined as a set of markdown files located in a subdirectory of /agents. (In the data folder). The name of the foler is the agents name.
These same agents also provide the main assistant's personality (the active agent) — there is no separate "profiles" store.
BOS must support creating a sub-agent dynamically. Such agents will only live for the duration of the task execution.
Sub-agents can be either a Local sub-agent, or a Claude sub-agent. Claude sub-agents must be used for any development task! This is important!
For any other task, the default must be to use a Local sub-agent.
If the assistant want to use a Claude Code agent for a none-coding task, it must ask the user for permission before doing so. An elisitation card should
show up if the assistants want's to ask this question with the choices: Allow Claude Agent once, Allow Claude Agent this session, Use Local.

## UI
Events such as tool calls / tool responses, reasoning, etc. must be shown in the UI. This also includes events from sub-agents. Such events must be shown in a nested structure. The nesting should happen on an agent level. For example something like this:
Assistant:
  |-Thinking
  |-Tool call - delegate_to: Researcher
  |-Researcher
  	|-Thinking
  	|-Tool call - web-search
  	|-Tool response
  	|- .......
  	|- .......
  	|-Responding
  |-Responding
(The example above is just for illustrating what is ment by "nesting". The point is that this will help the user understand what is going on)


### Right Sidepanel
The "Assistant" app must have a tabbed side panel:
- A tab showing the tools available to the current agent
- A tab showing the the skills that the agent has available
- A tab showing the MCP servers the agent has available, and the state of each MCP server. (Connected / Disconnected)

### Left Sidepanel
The left sidepanel is used for conversation management.
Start a new conversation, delete a conversation, or select and resume a conversation by clicking on it.

## Agent self improvement
The agent must be self improving similar to how Hermes-Agent does it.
Here are some key-points:
- Automatically create new skills from a conversation if found reasonable to do so.
- The assistant must perform self-reflection to evaluate how well it performed a task
- Use GEPA to improve any skill over time based on feedback from the user or self-reflection

## User interface
The chat must support streaming by default.
It must support receiving and rendering events like reasoning, tool calls / responses, etc.
It must support rendering in-line code blocks, markdown, html, etc. (HTML is rendered in a sandboxed iframe).
It must support MCP Apps / MCP-UI (interactive HTML resources returned by MCP tools, rendered in a sandboxed iframe).
Text content in apps (chat, editors, docs) must be **selectable** with the mouse. Do not disable text selection globally; only the desktop chrome (icons, dock, top bar, window title bars) opts out of selection.

## Planner agent
The planner agent is responsible for creating a plan for how to solve a given task.
A plan consists of a set of tasks:
- Name
- Description
- Acceptance criteria

## Developer sub-agent
BOS must have an out-of-the-box **Developer** sub-agent. All development/coding tasks are performed by Claude — never the local provider.

The Developer can modify BOS itself — its built-in apps, Settings pages, and server logic, i.e. the Next.js source under `src/`. This is distinct from building a standalone app:
- **Standalone app**: delegate to the Developer to produce a single self-contained `index.html`, then install it with `installApp` (the "Build App" skill). There is no dedicated build tool and no separate "Dev Studio" app.
- **Modifying BOS itself**: delegate the whole request to the Developer, which has repo-scoped access to BOS's own source. It works on a git feature branch, finds and edits the relevant files, typechecks, and stages the changes; edits under `src/` hot-reload in dev (the "Modify BrowserOS" skill encodes this).

The virtual file system (the file browser and the `listFiles`/`readFile`/`writeFile` tools) is the user's sandboxed data and does NOT contain BOS source. The assistant must never hunt for or edit BOS code through the VFS — it must delegate source changes to the Developer.

### How the Developer runs Claude Code
Configurable in **Settings → Dev Harness**:
- **Claude CLI (headless)** — the default and recommended mode. BOS spawns Claude Code non-interactively (`claude -p <task> --append-system-prompt <agent prompt> --output-format stream-json --dangerously-skip-permissions`) with the repo as the working directory. Claude itself is the autonomous coding agent (using its own Read/Edit/Write/Bash); BOS parses the stream-json output to surface tool calls live and capture the final result. Permissions are skipped for non-interactive use, so this is intended to run sandboxed (e.g. Docker); changes are confined to a feature branch.
- **MCP harness** — alternative: connect to a Claude Code MCP server (local stdio `claude mcp serve`, or remote HTTP/SSE) and drive its `Agent` tool. The `Agent` tool only runs a sub-agent whose `subagent_type` was registered on that harness at startup; if none match it cannot spawn. The headless CLI is preferred because it reliably runs Claude as the coder.

Repo-scoped tooling also exists for local sub-agents that opt in: read / list / search / write / edit source confined to the repo root (never secrets, `.git`, `node_modules`, lockfiles, or build config), an allowlisted command runner (typecheck / lint / build), and git branch/stage helpers. These tools are gated — the default sub-agent tool set is VFS-only.


# Extensibility
As with any real operating system, BOS provides APIs for extending the OS with new apps and functionality — used both by the assistant and to build apps from within the OS.
- **Installing apps**: an installed app is a set of files (entry `index.html`) written into the VFS and served same-origin at `/apps/<id>`, rendered in a window as an iframe. The assistant installs apps with `installApp` after the Developer builds them (the "Build App" skill). On install the app gets an appropriate icon and the desktop refreshes so the icon appears.
- **Removing apps** is two-phase: *uninstalling* hides an app from the desktop/dock (refreshed) but keeps its files so it can be restored; *purging* permanently deletes its files. Both are available in Settings → Apps and as assistant tools.
- **Development harness**: BOS runs Claude Code to build/modify apps and BOS itself — by default the headless Claude CLI in the repo, or a Claude Code MCP server (local `claude mcp serve` over stdio, or remote streamable-HTTP/SSE, e.g. http://wingman.akhbar.lan:7272/mcp). See the Developer sub-agent.

There is no separate "Dev Studio" app and no dedicated build tool; app creation goes through the Developer sub-agent plus `installApp`.

# BOS Self improvement
If the user asks the assistant to implement a new app or feature, BOS must evaluate if the implementation:
1) Will require making architectural changes for an optimal solution
2) Architectural changes should be made to better the quality of BOS

# Minimizing blas radius
Whenever changes are made to BOS, the changes MUST developed using a feature branch so that it can be rolled back if BOS breaks.
It's important that the agent adds new / stages files when during such work.

# Documentation
BOS must have a documentation hub containing user-friendly documentation for how to use BOS.
Whenever a new app or feature is created, added, modified, or removed, the documentation MUST be updated.

The full project documentation must be built and kept in the repository, split into two documents:
- **User documentation** (`docs/USER_GUIDE.md`) — how to use BOS: the desktop, the built-in apps, the Assistant, and Settings. The in-OS documentation hub (the Docs app, `data/docs`) presents this user-facing material to end users.
- **Development documentation** (`docs/DEVELOPMENT.md`) — primarily for the Assistant/developer sub-agent. It MUST describe the architecture, the repository layout, the data layout under `data/`, the API routes, the assistant/sub-agent subsystem, and concrete extension recipes and design heuristics — i.e. everything an AI assistant needs to make good design choices when implementing new apps or modifying BOS features. A root `CLAUDE.md` should orient the developer agent and point to this document and to this spec.

Both documents MUST be kept in sync with the codebase as features change; the development documentation MUST be updated whenever the architecture changes.

# Running Claude Code
The Developer (and any Claude sub-agent) runs Claude Code one of two ways (Settings → Dev Harness):
- **Headless CLI (default)**: spawn `claude -p` in the repo with stream-json output. Claude runs autonomously with its own tools; BOS streams its tool calls live and returns the final result. It runs with `--dangerously-skip-permissions` so it is non-interactive (intended to be sandboxed, e.g. Docker). No `agent_type` is involved — the sub-agent's instructions are passed as the appended system prompt.
- **MCP harness**: drive a Claude Code MCP server's `Agent` tool. Here an `agent_type` / `subagent_type` must be specified; it is **generated by the assistant per role** (developer, tester, ui_expert, …), not a single hardcoded/configured value. The harness only exposes agent types registered at its startup, so a generated type only runs if the harness has a matching agent; otherwise the `Agent` tool cannot spawn. The `Agent` tool runs opaquely, so at minimum show that the Claude agent is running and surface its result.

Either way, delegating to a Claude sub-agent must stream progress where possible.

# On first startup
The first time the user opens BOS, a configuration wizard appears where the user configures the AI provider/model and the Dev Harness — i.e. how Claude Code runs for the Developer sub-agent (headless Claude CLI by default, or an MCP harness).