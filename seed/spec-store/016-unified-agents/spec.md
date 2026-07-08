# Feature Specification: Unified Agent Model (a sub-agent is a role, not a type)

**Feature Branch**: `016-unified-agents`

**Created**: 2026-06-29

**Status**: Implemented (see `019-tools-and-sandbox` for the delivered end state)

> **Implementation note (2026-07-03):** delivered via `019-tools-and-sandbox`. Two divergences from the text below: (1) the capability registry uses a single `context: "action" | "tool" | "both"` field rather than separate `client`/`server` flags; (2) there is **no global active agent** — an agent's personality is per-conversation (`agentId` per conversation; `composeInstructions` throws on an empty id). Read "active agent" below as "this conversation's agent." See `discrepancies.md`.

**Input**: "Introducing 'sub-agents' as their own thing was a mistake. There are only **Agents**. An agent becomes a *sub-agent* simply by being called by another agent — so any agent can be a sub-agent. Capabilities (tools/skills/MCP) follow the agent: one allowlist governs it the same whether it runs as the active chat personality or when delegated to."

> Supersedes the deferred item in `TODO.md` ("Per-agent capability allowlist: `tools` spans two namespaces") and completes the per-agent scoping promised by `011`. Today "sub-agent" is a false type distinction that split capability scoping across two execution engines: server-side `toolsFor(agent.tools)` gates a *delegated* run (`runLocal`), while the *active* chat registers all CopilotKit actions in `CopilotProvider` with **no** per-agent gating. That produced the observed bug — Build Studio, scoped in Settings to spec tools, lists every main-chat action when it's the active personality (its `tools` are spec *sub-agent* ids, which aren't action names). The storage is already a single pool (`data/agents/*`); what makes "sub-agent" feel like a separate kind is the naming and the split gating. This feature unifies both.

## Clarifications

### Session 2026-06-29

- Q: Is "sub-agent" a type or a role? → A: A **role**. There is one concept — **Agent** (personality + capability set + execution backend). An agent is a "sub-agent" only while another agent is invoking it. Any agent can be invoked directly (active personality / embedded chat) or delegated to.
- Q: How do capabilities scope across those contexts? → A: **One allowlist per capability class (tools/skills/MCP) per agent**, governing it identically in every context. `unset/empty = all` (back-compatible).
- Q: How can one allowlist gate two different execution engines? → A: A single **capability registry** gives every tool a stable id plus the runtime context(s) it supports (client action, server tool, or both) and its binding(s). Gating then applies per context off the same list: CopilotKit's per-action `available` flag when the agent is active; `toolsFor()` when delegated. A tool valid in only one context is simply unavailable in the other.
- Q: Does this change how an agent executes (local vs Claude harness)? → A: No. `type: local | claude` is the **execution backend** and is orthogonal to capability scoping; it is unchanged.
- Q: Won't scoped agents break (their allowlists hold old sub-agent ids)? → A: A back-compat mapping/seed must ensure no agent silently loses capabilities; `unset = all` already protects the default Assistant.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One capability set governs an agent everywhere (Priority: P1)

A scoped agent has the same tools whether it is the active chat personality or delegated to.

**Acceptance Scenarios**:

1. **Given** Build Studio scoped (in Settings) to spec/authoring capabilities, **When** asked as the active BS-app personality to "list your tools," **Then** it reports only its allowed capabilities — not every main-chat action.
2. **Given** the same agent is delegated to by another agent, **When** it runs, **Then** it has the identical allowed set (no more, no less).

### User Story 2 - Disallowed tools are truly unavailable (Priority: P1)

**Acceptance Scenarios**:

1. **Given** an agent without `launchApp` in its allowlist, **When** it is the active personality, **Then** `launchApp` is not callable (disabled, not merely hidden).

### User Story 3 - One Settings capability list per agent (Priority: P1)

**Acceptance Scenarios**:

1. **Given** Settings → Assistant for an agent, **When** the user edits its capabilities, **Then** there is a single tools/skills/MCP list (drawn from the registry, with context tags) that takes effect in BOTH the active-chat and delegated contexts.

### User Story 4 - Build Studio authors specs directly (Priority: P1)

**Acceptance Scenarios**:

1. **Given** Build Studio as the active personality, **When** it creates/edits a spec, **Then** it uses its own spec capabilities directly (client-side spec actions) rather than being forced to delegate, because the unified registry exposes spec ops in the active context too.

### User Story 5 - "Sub-agent" disappears as a type (Priority: P2)

**Acceptance Scenarios**:

1. **Given** the codebase and UI, **When** a user or developer reads them, **Then** there is one "Agent" concept; delegation reads as "invoke/delegate to an agent," and no separate "sub-agent" type remains.

### Edge Cases

- A tool that only runs in one context (UI actions = client-only; repo/spec FS = server-only) is exposed only where it can run; "any agent can be a sub-agent" still holds.
- An agent invoking *itself* (or a cycle) must be depth-guarded (as `delegate_to_developer` already is).
- An agent with a `claude` backend invoked as the active personality vs delegated: backend selection is independent of capability scoping (out of scope to change here).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: There MUST be a single **Agent** concept (personality + capability allowlists + execution backend). The distinct "sub-agent" *type* is removed; an agent is a sub-agent only while being invoked by another agent. Naming across code and UI MUST reflect this (no `SubAgent` type; delegation reads as "delegate to an agent").
- **FR-002**: Each agent MUST carry ONE allowlist per capability class — tools, skills, MCP — that governs it in EVERY context (active personality / embedded chat AND delegated). `unset/empty = all`.
- **FR-003**: A single **capability registry** MUST enumerate every tool by a stable id with: display name, description, group, the runtime context(s) it supports (`client` action and/or `server` tool), and its binding(s). The current split sources (`tool-manifest.ts`, `SUBAGENT_TOOLS`/`DEV_TOOLS`/`SPEC_TOOLS`) MUST converge into (or be generated from) this registry so ids are shared.
- **FR-004**: When an agent is the active personality / embedded chat, its **main-chat actions MUST be filtered to its allowed set** — implemented with CopilotKit's per-action `available` flag keyed to the active/pinned agent (thread `agentId`, as `McpActions` already does). Disallowed actions MUST NOT be callable.
- **FR-005**: When an agent is delegated to, its **server tools MUST be filtered to the same allowed set** (`toolsFor()`), using the same ids as FR-003.
- **FR-006**: Capabilities an agent needs to function as the active personality MUST be expressible in its allowlist. In particular, add **client-side spec actions** so Build Studio authors specs directly (resolving today's "spec ops are server-only sub-agent tools" gap), and ensure each built-in scoped agent's allowlist lists the real ids it uses.
- **FR-007**: Settings → Assistant MUST present **one capability list per agent** (tools/skills/MCP) sourced from the registry (with context tags), replacing the current sub-agent-only catalog, and edits MUST apply to both contexts.
- **FR-008**: Migration MUST be back-compatible: existing `AGENT.md` allowlists keep working and no agent silently loses capabilities (map legacy ids and/or additive ensure on upgrade). The default Assistant (`unset = all`) is unaffected.
- **FR-009**: `type: local | claude` (execution backend) MUST remain unchanged and independent of capability scoping.

### Key Entities

- **Agent** — (was `SubAgent`) name/id, description, personality (systemPrompt), `type` backend, and tools/skills/MCP allowlists. Stored under `data/agents/<id>/AGENT.md` (unchanged location).
- **Capability descriptor** — `{ id, name, description, group, contexts: ("client"|"server")[], … }` in the registry.
- **Capability registry** — the single source of truth mapping ids → descriptors + bindings; consumed by the active-chat gating, the delegated `toolsFor()`, the Settings catalog, and the InfoPanel.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Asked to list its tools, a scoped agent (e.g. Build Studio) reports only its allowed capabilities, identically as active personality and when delegated.
- **SC-002**: A disallowed action cannot be invoked by a scoped active agent (verified by attempt, not just by omission from a list).
- **SC-003**: Editing one capability list in Settings changes what the agent can do in BOTH contexts.
- **SC-004**: Build Studio creates/edits a spec directly as the active personality (no forced delegation for file ops).
- **SC-005**: After upgrade, no existing agent loses capabilities it had.
- **SC-006**: No `SubAgent` type remains; delegation reads as invoking an agent.

## Assumptions & Dependencies

- Supersedes the `TODO.md` two-namespace item; completes `011-per-agent-capabilities`.
- Interacts with `012` (embedded chats pin an agent → thread `agentId` for gating), `013` (Build Studio as active personality + spec authoring), `014` (the MCP gateway actions are registry entries).
- CopilotKit's per-action `available: "enabled" | "disabled"` flag is supported (confirmed in node_modules).
- Storage is already a single pool of agents; this is largely a naming + gating + registry change, not a data migration.

## Migration / touchpoints (for sizing)

- **`src/lib/agent/subagents/`** → rename to `agents/` (or keep path, drop the name): `SubAgent`→`Agent`, `getSubAgent`→`getAgent`, `listSubAgents`→`listAgents`, etc. Broad but mechanical rename.
- **Tool sources** → introduce the capability registry; converge `tool-manifest.ts` (client action names) with `SUBAGENT_TOOLS`/`DEV_TOOLS`/`SPEC_TOOLS` (server tool ids) onto shared ids; tag each with context.
- **`CopilotProvider`** → gate each `*Action` via `available` keyed to the active/pinned agent's allowlist (thread `agentId`; `McpActions` already receives it).
- **`SpecActions`** (new client actions) + any other client actions needed so scoped agents (esp. Build Studio) can work as the active personality.
- **`/api/assistant/agent`** `buildCatalog` → serve the unified registry (ids + groups + context tags) instead of only sub-agent tool ids.
- **Settings `AssistantTab` / AgentCapabilities editor** → one capability list per agent from the registry.
- **Delegation surface** → `delegateToSubAgent`/`listSubAgents`/`createSubAgent`/`delegate_to_developer` reframed as agent-invocation (keep behavior; depth guard stays).
- **Back-compat** → map legacy allowlist ids; ensure built-in agents' allowlists list their real ids; keep `unset = all`.
- **Out of scope**: changing execution backends (`local`/`claude`), and the supervisor/self-modification pipeline.
