# Feature Specification: BrowserOS Core (Shell, Assistant, Configuration)

**Feature Branch**: `000-browseros-core`

**Created**: 2026-06-28 (migrated from `spec/bos.md`)

**Status**: Implemented

**Input**: "A single-page, server-side-rendered operating system in the browser with a file browser, a proxied web browser, and an agentic assistant that can operate and modify BOS itself."

> Migrated from the canonical overview `spec/bos.md`. Governing principles moved to the constitution (`.specify/memory/constitution.md`); detailed sub-systems moved to feature folders `001`–`010`. This spec captures the foundational requirements that no single feature folder owns: the OS shell, the assistant/agent runtime, and the configuration system.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A usable desktop OS (Priority: P1)

The user gets a desktop with a file browser and a web browser (external pages loaded through a same-origin proxy), and can change the wallpaper.

**Acceptance Scenarios**:

1. **Given** the desktop, **When** the user opens the Files app, **Then** they can browse the virtual file system.
2. **Given** the Browser app, **When** the user loads an external page, **Then** it renders inside the OS without CORS/MIME errors via the proxy.

### User Story 2 - An assistant that can do anything in BOS (Priority: P1)

A built-in chat (CopilotKit) talks to the BOS agent, which can open/control apps, manage files, browse, change settings, manage MCP servers, build apps/features, and remember things — streaming its work as events.

**Acceptance Scenarios**:

1. **Given** a request, **When** the assistant works, **Then** thinking, tool calls/responses, and sub-agent events stream live as collapsible, nested cards with a busy/done indicator.

### User Story 3 - Pluggable configuration (Priority: P1)

An app or feature registers a config namespace that renders a Settings tab and is auto-exposed to the assistant as tools.

**Acceptance Scenarios**:

1. **Given** a registered namespace, **When** Settings opens, **Then** a tab renders for it, and the assistant has matching configuration tools.

### User Story 4 - Always delegate to sub-agents (Priority: P1)

The assistant delegates substantive work to a sub-agent (creating one if needed); Claude for development, local otherwise.

### User Story 5 - First-run setup (Priority: P2)

On first start, a wizard configures the AI provider/model, the Dev Harness, and the data-isolation method.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: BOS MUST provide a desktop with a file browser and a web browser, and the wallpaper MUST be changeable.
- **FR-002**: The web browser MUST render external pages through a **same-origin, path-based rewriting proxy** (e.g. `/api/proxy/<scheme>/<host>/<path>`): rewrite HTML (`src`/`href`/`action`/`poster`), CSS (`url()`/`@import`), inject a runtime shim re-routing dynamic `fetch`/XHR, strip page CSP/`<base>`, and disable trailing-slash redirects for proxy paths. Out of scope: DRM/streaming media and WebSockets.
- **FR-003**: BOS MUST have a built-in chat to the BOS agent; the agent MUST support MCP servers; the chat MUST use CopilotKit.
- **FR-004**: BOS MUST provide a configuration system where apps/features register a config schema (fields or a custom component) that renders one Settings tab per namespace AND is auto-exposed to the assistant as tools. Built-in tabs include Assistant, Skills, MCP Servers, Apps, Appearance, AI Provider, and Dev Harness.
- **FR-005**: AI providers (OpenAI, OpenAI Codex, Anthropic, and local OpenAI-compatible) MUST be configurable — model, API key (masked; never returned to the client in plaintext), base URL, max output tokens, and context window. Reasoning/"thinking" models MUST be supported: large enough output budget, Chat Completions (not Responses) for OpenAI-compatible, and `reasoning_content` surfaced as "thinking".
- **FR-006**: BOS MUST support multiple agents as the assistant's personality, selectable in the Assistant app; the assistant can do anything in BOS (build apps/features, configure settings, open apps) and MUST always delegate substantive tasks to a sub-agent (creating one if none fits).
- **FR-007**: Assistant events (thinking, tool calls/responses, and sub-agent events) MUST stream live as collapsible cards that auto-collapse, nested per agent, with a busy/done indicator. Collapse state MUST live outside the per-card React lifecycle (a module-level store) AND MUST be **scoped per chat surface** — when two surfaces are visible at once (e.g. the Assistant app plus an embedded chat, per `012`), toggling a card in one surface MUST NOT affect cards in another. Card headers MUST remain **operable while the chat runtime remounts the card's view on re-render** (which the CopilotKit tool-call/generative-UI view does whenever the chat re-renders); a header toggle therefore MUST NOT rely on an interaction that requires the same element to survive a press→release `click` (use a single pointer/keyboard event).
- **FR-008**: The Assistant app MUST have a right side panel (tabs: tools, skills, MCP servers with state) and a left side panel for conversation management (new/delete/select/resume).
- **FR-009**: Agents MUST be stored as markdown directories under `data/agents`; sub-agents are Local or Claude; Claude MUST be used for any development/coding task and Local by default otherwise; dynamic ephemeral sub-agents MUST be supported; using Claude for a non-development task MUST first ask the user via an elicitation (allow once / this session / use local).
- **FR-010**: A planner agent MUST produce a plan as tasks, each with a name, description, and acceptance criteria.
- **FR-011**: A Developer sub-agent MUST modify BOS's own source (`src/`) on a git feature branch via the Dev Harness (headless Claude CLI by default, or an MCP harness); standalone apps are produced by the Developer and installed via `installApp`/`buildApp`; the VFS is the user's sandbox and is NOT BOS source.
- **FR-012**: The UI MUST stream chat by default and render markdown, code blocks, HTML (sandboxed iframe), and MCP-UI; text content in apps MUST be selectable (only the desktop chrome opts out).
- **FR-013**: The assistant MUST have a self-improving memory system and a skills library (detailed in `002-memory` and `003-self-improvement`); memory is injected into the assistant's instructions.
- **FR-014**: On first startup a configuration wizard MUST appear (only when no AI credentials are configured) to set the AI provider/model, the Dev Harness, and the data-isolation method (only host-compatible methods selectable).
- **FR-015**: BOS MUST provide extensibility for installing apps (sandboxed iframes served from the content repo) and for removing them (uninstall/restore/purge), used by the assistant and from within the OS.
- **FR-016**: Conversations MUST be persisted and restorable, and **restoring a conversation MUST be display-only**: opening or switching to a conversation MUST NOT start or resume an agent run, MUST NOT re-execute its tool calls, and MUST NOT append any message. This MUST hold even for a *completed* conversation whose history contains tool-call turns (not only for conversations persisted mid-run). To guarantee it: (a) a conversation persisted mid-run — ending in tool results, or an assistant message with pending tool calls — MUST be trimmed on load to its last **settled boundary** (a user message, or a completed assistant text reply) so the runtime has nothing to continue or re-execute; and (b) each conversation MUST be loaded into the chat runtime **at most once per open**, a load that is resilient to chat-runtime re-renders (e.g. the agent object's identity changing during a run) and that MUST NEVER re-load over an in-flight turn. A transient agent (re)connect on restore is acceptable only if it appends nothing and produces no generated output.
- **FR-017**: BOS MUST let users **configure MCP servers from Settings** (a dedicated "MCP Servers" section), keyed by a unique name. It MUST support three transports: **streamable HTTP**, **SSE**, and **stdio**. For http/sse it MUST accept a server URL plus an optional bearer token AND arbitrary **custom request headers** (e.g. `Private-Token`). For stdio it MUST accept a **command, arguments, environment variables, and an optional working directory** (e.g. a local `docker run … ghcr.io/github/github-mcp-server`). Each server MUST be **testable from the UI**: a Test action connects and lists the server's tools (or reports the error) WITHOUT saving. Configured servers' tools are auto-exposed to the agent and can be scoped per agent (per `011`). The same operations MUST also be available to the agent as tools (add/remove/list/probe).

### Key Entities

- **Desktop / window manager** — the OS shell.
- **App** — built-in (React folder `src/apps/<id>/`) or installed (iframe content).
- **Agent / sub-agent** — markdown under `data/agents`; local or claude.
- **Conversation** — managed in the Assistant's left panel.
- **Config namespace** — a Settings tab + assistant tools.
- **Provider config** — model/key/base-URL/budgets (key masked).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The user can browse files and load external web pages inside the OS.
- **SC-002**: The assistant can build/modify apps and features and change settings.
- **SC-003**: Adding a config namespace yields both a Settings tab and assistant tools.
- **SC-004**: Every substantive task is delegated to a sub-agent (Claude for development).
- **SC-005**: Reopening any saved conversation (including one with tool-call history) appends no messages and starts no agent run; its event cards still expand/collapse on click.
- **SC-006**: With the Assistant app and an embedded chat open at once, expanding a card in one leaves the other's cards unchanged.
- **SC-007**: A user can add an MCP server of each transport (streamable HTTP, SSE, stdio — including one with custom headers and one local stdio command with env) in Settings, Test it to see its tool list, and the agent can then use its tools.

## Notes

- Detailed sub-systems: `001-build-studio`, `002-memory`, `003-self-improvement`, `004-browser-automation`, `005-self-modification`, `006-data-isolation`, `007-gitfs`, `008-self-testing`, `009-installed-apps`, `010-documentation`. Principles: the constitution.
- Faithful migration of `spec/bos.md`; original prose remains in git history.
