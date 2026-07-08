# Implementation Plan: Embeddable Assistant (Integration Plane)

**Branch**: `012-embeddable-assistant` | **Date**: 2026-06-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-embeddable-assistant/spec.md`

## Summary

Extract the chat into a reusable, **agent-scoped `<AssistantChat>` embed** — each instance mounts its own **top-level** CopilotKit provider (there must be NO global/app-wide provider; see Design notes), with its own conversation thread, chrome toggles, and pinned agent. Refactor the Assistant app to consume it. Conversations are **keyed by `agentId`** (the Assistant shows all agents' conversations nested; an embed shows only its configured agent's). `011` already added `composeInstructions(agentId?)` and `buildRuntimeOptions(agentId?)`.

## Technical Context

**Language/Version**: TypeScript — Next.js (App Router), React, CopilotKit.

**Primary Dependencies**: existing — `@copilotkit/react-core`/`react-ui`, the conversations store, `useChatPersistence`. No new deps.

**Storage**: conversations are JSON files in the VFS at `/Documents/Chats/<id>.json`; each file carries an `agentId` field that serves as the partition key. Old files with a `group` field migrate transparently on first read.

**Testing**: Playwright e2e — the Assistant app still works (existing desktop suite) + an embedded chat renders.

**Project Type**: Web — single Next.js project.

**Constraints**: server/client boundary; must not regress the Assistant; conversation layout change must be back-compatible.

## Constitution Check

- **I. Spec-Driven**: derived from `spec.md`. PASS.
- **II. Server boundary**: instructions/MCP scoping stay server-side (`composeInstructions`/`buildRuntimeOptions`); the embed is a client component over the existing `/api/copilotkit` runtime. PASS.
- **III. Delegate / Claude codes**: built by the Developer. PASS.
- **IV. Blast radius**: feature branch; the Assistant app + existing e2e guard the refactor. PASS.
- **V. VFS ≠ source**: conversations live in the VFS (user data) — unchanged in principle. PASS.
- **VI. Docs sync**: update `docs/usage/assistant` + `docs/dev/assistant`. PASS.
- **VII. Boundaries**: no secrets/lockfiles. PASS.

## Project Structure

```text
src/components/agent/
├── AssistantChat.tsx       # NEW — the embeddable surface (own provider + chat + persistence + chrome)
├── CopilotProvider.tsx     # EDIT — accept agentId; derive threadId from activeByAgent[agentId]
└── ChatPersistence.tsx     # EDIT — key persistence by agentId (→ active conversation for that agent)

src/lib/agent/conversations.ts            # EDIT — agentId-keyed: Conversation.agentId (no group),
                                          #        flat /Documents/Chats/<id>.json, per-agent active id,
                                          #        migration from legacy group field
src/components/apps/assistant/ConversationPanel.tsx  # EDIT — agentId? prop: unset = all agents nested;
                                                      #        set = only that agent's conversations
src/apps/chat/index.tsx                   # EDIT — consume <AssistantChat showConversations showInfo />
```

**Structure Decision**: `<AssistantChat>` is the single embeddable surface; the Assistant app becomes its first consumer (full chrome, all agents). Build Studio embeds it with `agentId={buildStudioAgent}` (configurable in Settings → Build Studio).

## Design notes

### Embeddable component (`<AssistantChat>`)
Props: `agentId?` (pin agent; default = DEFAULT_AGENT_ID), `showConversations?`, `showInfo?` (chrome), `allGroups?` (show all agents' conversations — used by the Assistant app). It renders its **own** `CopilotProvider`, composes instructions for `agentId` via `/api/assistant/agent?agentId=…`, and mounts `<CopilotChat>` + `useChatPersistence` + `ChatToolRenderer`. It also wraps the chat in a **per-surface card-collapse scope** (core `FR-007`) so its event-card accordion is independent of other surfaces.

### Per-surface provider — NO global provider
`CopilotProvider` is parameterized by `agentId`; it derives `threadId = activeByAgent[agentId]` and registers the `*Actions` inside its sub-tree. **Each chat surface mounts its own provider as a top-level sibling, and there must be NO global/app-wide `<CopilotKit>` provider wrapping them.** Nested CopilotKit providers do NOT isolate — an outer/global provider dominates inner ones, so every surface would share one runtime/thread (the shared-chat bug). So the global provider must be **removed from `src/app/page.tsx`**; the Assistant app and every embed are independent sibling providers → no thread/agent cross-talk.

### Conversation partitioning
`Conversation` carries `agentId: string` as its sole partition key (the legacy `group` field is removed). On disk: `/Documents/Chats/<id>.json` (flat). Old files with a `group` field are read back transparently: a non-`"assistant"` group maps directly to `agentId` (e.g. `group: "build-studio"` → `agentId: "build-studio"`); `"assistant"` maps to `DEFAULT_AGENT_ID`. The store exposes **agentId-scoped** views: `useConversations(agentId)`, `useActiveConversationId(agentId)`, and `new/select/delete` scoped to an agent, with a per-agent active id (localStorage keyed as `bos.activeConversation.<agentId>`). `ConversationPanel` with no `agentId` prop lists **all agents, nested**; with `agentId` lists only that agent's conversations.

### Active-conversation highlight (single selection)
In the all-agents panel, at most one conversation is highlighted at a time. The highlight is constrained to `c.agentId === currentAgentId && activeByAgent[c.agentId] === c.id`, where `currentAgentId` is the agent the host is currently viewing. Switching to a conversation belonging to a different agent calls `setCurrentAgentId(c.agentId)`, which deactivates the previous agent's highlight.

### Build Studio agent configuration
Build Studio reads its configured agent from `GET /api/config/build-studio` (field `agent`, default `"build-studio"`). The user can change it in Settings → Build Studio. On mount, Build Studio loads the config and passes `agentId={buildStudioAgent}` to `<AssistantChat>`.

### Runtime agent threading
Instructions are passed client-side (the `instructions` prop), so agent personality/skills scope correctly per embed. MCP scoping is server-side in `buildRuntimeOptions(activeAgent)` — the embed's `agentId` is threaded to the runtime via the URL (`/api/copilotkit?agent=…`), read in the route → `buildRuntimeOptions(agentId)`.

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|-----------|------------|--------------------------------------|
| Refactoring the core chat (`conversations.ts`, `CopilotProvider`) | Embedding requires the thread/agent to be parameterized rather than a single global | Copying the chat per app (the original idea) would duplicate the most complex code and diverge; the user explicitly wants the Assistant reused as a platform primitive |
| Removing `group` from `Conversation` | `agentId` is the sufficient and natural partition key; keeping both caused a double-highlight bug | Adding a `currentGroup` guard to the highlight check was a short-term workaround — having two partition fields is the root cause |

## Out of scope

`013` (Build Studio consuming the embed); per-embed *action* scoping (the `011` deferral in `TODO.md`); multi-user conversation sharing.
