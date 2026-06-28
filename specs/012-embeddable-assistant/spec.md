# Feature Specification: Embeddable Assistant (Integration Plane)

**Feature Branch**: `012-embeddable-assistant`

**Created**: 2026-06-28

**Status**: Draft

**Input**: "BOS is AI-first, so the Assistant is a platform capability: any app can embed the assistant chat — scoped to a chosen agent, with the side-panel chrome toggled — bound to the shared conversation store. The Assistant app becomes one consumer of its own embed API."

> Current state: the chat is `<CopilotChat instructions={composeInstructions()}>` under a global CopilotKit provider (all actions registered globally; thread = the active conversation). `ConversationPanel` (left) and `InfoPanel` (right) are already toggleable. Instructions compose the *global* active agent. This feature turns that into a reusable, agent-scoped embed. Pairs with `011-per-agent-capabilities`; consumed by `013-build-studio-agentic`.

## Clarifications

### Session 2026-06-28

- Q: How are conversations partitioned across embeds (FR-004)? → A: Conversations belong to a **group/partition**. The **Assistant app shows all conversations grouped** (nested, like the Docs and Specs trees); an **embed shows only its own group** — e.g. Build Studio shows only Build Studio conversations. The group maps to the embed's scope (its agent/provider).
- Q: Can multiple agent/thread-scoped chats coexist (FR-006)? → A: Yes. CopilotKit's provider can wrap a **sub-tree** (per its docs) and accepts `threadId` + `agent` props, so an embed mounts its **own CopilotKit provider** scoped to its sub-tree, with its own `threadId` (→ its conversation group) and agent/instructions; the Assistant app keeps the global provider. This gives independent agent + conversation scoping with no cross-talk.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Embed the assistant in any app (Priority: P1)

An app mounts a reusable component to get the full chat experience — streaming, live events, tools, memory, skills, delegation.

**Acceptance Scenarios**:

1. **Given** a second app, **When** it mounts the embeddable assistant, **Then** a working chat appears with the same capabilities as the Assistant app.

### User Story 2 - Scope to a chosen agent (Priority: P1)

The embedding app pins the chat to a specific agent (e.g. Build Studio), independent of the global active personality.

**Acceptance Scenarios**:

1. **Given** an embed pinned to agent X, **When** the user chats, **Then** the chat uses X's composed instructions (and X's scoped skills per `011`), regardless of the globally active agent.

### User Story 3 - Configurable chrome (Priority: P1)

The embed can show/hide the conversation panel and the tools/skills/MCP info panel independently.

**Acceptance Scenarios**:

1. **Given** an embed configured with both panels off, **When** it renders, **Then** only the chat is shown (host app supplies its own surrounding UI).

### User Story 4 - Shared conversation store (Priority: P1)

Embedded chats use the same conversation storage/management as the Assistant (start / resume / delete).

### User Story 5 - The Assistant app is a consumer (Priority: P2)

The built-in Assistant app is refactored to use the same embed API (dogfood) — full chrome, global active agent.

### Edge Cases

- Two assistant surfaces coexisting (Assistant app + an embed) must not bleed agent scope or conversation context into each other.
- An embed pinned to an agent that was deleted should fall back gracefully.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: BOS MUST provide a reusable, documented **embeddable assistant** surface (a component plus supporting server API) that mounts the full chat: CopilotChat + live event rendering + tool renderer + conversation persistence.
- **FR-002**: The embed MUST accept an **agent scope** — pin the chat to a named agent so its instructions are composed for that agent, independent of the global active personality.
- **FR-003**: The embed MUST accept **chrome options** — show/hide the conversation panel (left) and the info panel (right) independently.
- **FR-004**: Conversations MUST be **partitioned into groups** on the shared conversation store: each conversation belongs to a group keyed by the embed's scope (its agent/provider). The **Assistant app MUST display conversations grouped** (nested, like the Docs/Specs trees); an **embed MUST show only its own group** (e.g. Build Studio shows only Build Studio conversations).
- **FR-005**: `composeInstructions` MUST support composing instructions for a **specified agent** (honoring that agent's scoped skills per `011`), not only the global active agent.
- **FR-006**: Multiple assistant surfaces MUST coexist without cross-talk. Mechanism: an embed mounts its **own CopilotKit provider scoped to its sub-tree** (CopilotKit supports a provider over a sub-tree, with `threadId` + `agent` props), giving each embed its own conversation thread/group and agent; the Assistant app keeps the global provider.
- **FR-007**: The built-in **Assistant app MUST be refactored to consume this embed API**, becoming the reference consumer (full chrome, global active agent).
- **FR-008**: The embed MUST stream the same live events as the Assistant (thinking, tool calls/responses, and nested sub-agent events).

### Key Entities

- **Embeddable assistant** — the reusable component + its props (agent scope, chrome options, conversation scope).
- **Agent scope** — which agent the embed is pinned to.
- **Conversation / thread** — the persisted chat context.
- **CopilotKit runtime** — the shared `/api/copilotkit` runtime + registered actions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A second app can mount a fully working assistant chat.
- **SC-002**: That chat is pinned to a chosen agent regardless of the global active agent.
- **SC-003**: The side panels can be toggled off so the host app controls the chrome.
- **SC-004**: The Assistant app itself runs on the embed API.
- **SC-005**: Embedded and Assistant chats do not bleed agent or conversation context.

## Assumptions & Dependencies

- Depends on `011-per-agent-capabilities` for agent-scoped skill composition.
- Consumed by `013-build-studio-agentic`.
- Reuses the existing CopilotKit wiring (`CopilotProvider`, `/api/copilotkit`, `useChatPersistence`, `ChatToolRenderer`) rather than a new chat implementation.
