# Feature Specification: Per-Agent Capabilities (Tools, Skills, MCP)

**Feature Branch**: `011-per-agent-capabilities`

**Created**: 2026-06-28

**Status**: Draft

**Input**: "Configure, per agent, which tools, skills, and MCP servers it may access — from Settings — so each agent (e.g. Build Studio) has a scoped capability set instead of every agent seeing everything."

> Current state: **tools** are already per-agent for sub-agents (`AGENT.md` `tools` allowlist via `toolsFor()`), but **skills** (`composeInstructions()` injects *all* skills) and **MCP servers** (a single global `mcp-servers.json`) are not scoped per agent, and there is no UI to manage any of it. Foundational for `012-embeddable-assistant` and `013-build-studio-agentic`.

## Clarifications

### Session 2026-06-28

- Q: Can CopilotKit actions be gated individually per agent (FR-002)? → A: Yes, it's feasible. Actions are registered via `useCopilotAction` inside the provider; the guaranteed mechanism is to **conditionally register/expose actions per active agent** (the `*Actions` components read the active agent and only register its allowed tools). A built-in `available` flag MAY be used if the installed CopilotKit version supports it; conditional registration is the fallback that always works. Exact mechanism finalized in `/plan`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Scope an agent's capabilities (Priority: P1)

In Settings, for each agent, the user picks which tools, skills, and MCP servers it may use. Leaving a class unset means "all" (no change from today).

**Acceptance Scenarios**:

1. **Given** an agent in Settings, **When** the user restricts its skills to a subset, **Then** only those skills are available to that agent.
2. **Given** an agent with no explicit access set, **When** it runs, **Then** it has access to everything (back-compatible default).

### User Story 2 - The agent honors its scope (Priority: P1)

When an agent is active (main chat) or delegated to (sub-agent), it only sees/uses its allowed tools, skills, and MCP servers.

**Acceptance Scenarios**:

1. **Given** an agent scoped to a skill subset, **When** its instructions are composed, **Then** the skills index lists only its allowed skills.
2. **Given** an agent denied an MCP server, **When** it runs, **Then** that server's tools are not exposed to it.

### User Story 3 - Sensible built-in defaults (Priority: P2)

Built-in agents ship with sensible scopes (e.g. Build Studio = spec tools + the Build Studio skill; Developer = dev tools).

### Edge Cases

- The main assistant's actions are global CopilotKit actions today; scoping tools for the *active personality* means filtering those actions, not only sub-agent runs.
- Removing access to a tool/skill an agent's prompt relies on should degrade gracefully (the agent simply lacks it), not crash.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each agent MUST carry an access specification for three capability classes — **tools**, **skills**, **MCP servers** — persisted in its `AGENT.md` (allowlists; unset/empty = all, preserving current behavior).
- **FR-002**: The existing per-agent `tools` allowlist MUST continue to gate sub-agent runs; additionally the **main assistant's available actions MUST be filtered to the active agent's allowed tools**, implemented by conditionally registering/exposing actions per active agent (a CopilotKit `available` flag MAY be used if supported; conditional registration is the guaranteed fallback).
- **FR-003**: `composeInstructions` MUST include only the active agent's allowed **skills** in the skills index (the loadable library is filtered per agent) instead of all skills.
- **FR-004**: The **MCP** servers/tools exposed to an agent MUST be limited to its allowed set (the global registry remains, but per-agent visibility is filtered). The global MCP registry itself is created/edited in Settings → MCP Servers (core `FR-017`: streamable-http/SSE/stdio, custom headers, and a Test action); this feature only filters which of those each agent sees.
- **FR-005**: Configuration MUST live in **Settings**, extending the **Assistant** tab (which manages agents): selecting an agent lets the user edit its tool/skill/MCP access. Per the configuration system, this is also exposed to the assistant as tools.
- **FR-006**: Scoping MUST apply consistently whether the agent runs as the active personality (main chat) or as a delegated sub-agent.
- **FR-007**: Built-in agents MUST ship with sensible default scopes; unset access MUST mean full access (no regression for existing or user-created agents).
- **FR-008**: The Assistant's right-side InfoPanel (tools/skills/MCP) MUST reflect the active agent's scoped set.

### Key Entities

- **Agent** — now carries `tools` / `skills` / `mcp` allowlists.
- **Capability class** — one of tools, skills, MCP.
- **Access specification** — the per-agent allowlist per class (unset = all).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can restrict an agent to a subset of tools/skills/MCP from Settings.
- **SC-002**: A scoped agent's composed instructions list only its allowed skills.
- **SC-003**: A scoped agent cannot invoke a disallowed tool or MCP server.
- **SC-004**: An agent with unset access retains full access (no regression).

## Assumptions & Dependencies

- Tools already have a per-agent allowlist; this extends the model to skills + MCP and adds the UI + enforcement.
- Enables `013-build-studio-agentic` (a properly-scoped Build Studio agent) and pairs with `012-embeddable-assistant` (agent-scoped instruction composition).
