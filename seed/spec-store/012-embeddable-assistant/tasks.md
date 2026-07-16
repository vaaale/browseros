---
description: "Task list for Embeddable Assistant (012-embeddable-assistant)"
---

# Tasks: Embeddable Assistant (Integration Plane)

**Input**: Design documents from `/specs/012-embeddable-assistant/`

**Prerequisites**: plan.md, spec.md; `011` (composeInstructions/buildRuntimeOptions take an agentId).

**Tests**: Included — typecheck/lint + Playwright (the Assistant must not regress).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 Create the `bos/embeddable-assistant` feature branch (developer).
- [x] T002 [P] Add `agentId: string` as the sole partition key to the `Conversation` type in `src/lib/agent/conversations.ts` (the earlier `group: string` design was superseded — see spec Clarifications 2026-07-05).

---

## Phase 2: Foundational (Blocking — the core refactor)

- [x] T003 Make `src/lib/agent/conversations.ts` **agentId-keyed**: remove the `group` field; conversations stored flat at `/Documents/Chats/<id>.json` (unchanged on disk — files carry `agentId` in their JSON); a per-agent active id (localStorage keyed as `bos.activeConversation.<agentId>`); agentId-scoped APIs (`useConversations(agentId)`, `useActiveConversationId(agentId)`, `new/select/delete` per agent); back-compat migration reads the legacy `group` field and maps it to `agentId` on load.
- [x] T004 Parameterize `src/components/agent/CopilotProvider.tsx` — accept `agentId` only (no group); derive `threadId = activeByAgent[agentId]` internally; keep the `*Actions` registered inside.
- [x] T005 Key `src/components/agent/ChatPersistence.tsx` by `agentId` so each agent's active conversation persists correctly. Restore MUST be **display-only and load-once** (core `FR-016`): load a thread at most once per open, claim it synchronously so the agent object's identity churn during a run does NOT re-trigger a load, and never re-load over an in-flight turn.

**Checkpoint**: conversations partition by agentId; existing chats still load (migrated from group field).

---

## Phase 3: User Stories 1–3 — Embed, agent scope, chrome (P1)

- [x] T006 Add `src/components/agent/AssistantChat.tsx` — the embeddable surface: its own `CopilotProvider`, instructions composed for `agentId`, `useChatPersistence` + `ChatToolRenderer`, and chrome props (`showConversations?`, `showInfo?`, `allGroups?`). Wrap the chat in a **per-surface card-collapse scope** (`FR-009`, core `FR-007`) so its event-card accordion is independent of other surfaces.
- [x] T007 Thread the embed's `agentId` to `/api/copilotkit` via the runtime URL (`/api/copilotkit?agent=…`) so `buildRuntimeOptions(agentId)` scopes MCP correctly.

---

## Phase 4: User Story 4 — Partitioned conversations UI (P1)

- [x] T008 `src/components/apps/assistant/ConversationPanel.tsx` — `agentId?` prop: unset → list **all** conversations **nested by agent**; set → only that agent's conversations. In the all-agents view, `currentAgentId` constrains the highlight so exactly one conversation is active at a time (FR-010).

---

## Phase 5: User Story 5 — Assistant consumes the embed (P2)

- [x] T009 Refactor `src/apps/chat/index.tsx` to render `<AssistantChat allGroups showConversations showInfo />` (the reference consumer); remove the now-duplicated provider/chat wiring.
- [x] T009a **Remove the global `<CopilotKit>`/`CopilotProvider` from `src/app/page.tsx`.** Each chat surface (the Assistant app via `<AssistantChat>`, every embed) is the sole top-level provider for its own sub-tree. Nested CopilotKit providers do NOT isolate, so a global provider would collapse all surfaces onto one runtime/thread.

---

## Phase 6: agentId partition refactor (follow-up, 2026-07-05)

- [x] T013 Remove `Conversation.group` entirely; replace `activeByGroup` with `activeByAgent` throughout; update all consumers (`CopilotProvider`, `AssistantChat`, `ChatPersistence`, `ConversationPanel`, `AgentSelector`, `SubAgentActions`, `GitActions`). Add migration in `readConversationFile`.
- [x] T014 Fix double-highlight bug in all-agents `ConversationPanel`: constrain active indicator to `c.agentId === currentAgentId` (FR-010).
- [x] T015 Add Build Studio agent configuration: Settings → Build Studio (agent picker); `GET/PATCH /api/config/build-studio`; Build Studio reads config on mount and passes `agentId` to `<AssistantChat>`.
- [x] T016 [P] Update spec.md, plan.md, tasks.md, `docs/dev/build-studio.md`, `docs/dev/repository-and-data-layout.md` to reflect agentId-as-partition.

---

## Phase 7: Polish & Cross-Cutting

- [x] T010 [P] Docs: `docs/usage/assistant/*` + `docs/dev/assistant/*` for the embeddable assistant + agentId-based conversation partitioning.
- [ ] T011 [P] Tests: the existing desktop e2e (opens the Assistant) must still pass; add an embedded-chat smoke (full coverage lands with `013`, which provides a real embed). Add isolation guards: starting a new conversation in one surface MUST NOT appear in the other (unless same agentId), and each surface's event-card accordion toggles independently. Add a restore guard: reopening a conversation with tool-call history appends nothing, starts no run, and its tool-card headers still toggle on click (core `FR-016`, `FR-007`).
- [x] T012 Run typecheck + lint to green; `/speckit.analyze` on `012`.

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → **Foundational (T003–T005)** → **Embed (T006–T007)** → **Conversations UI (T008)** → **Assistant consumer (T009)** → **agentId refactor (T013–T016)** → **Polish (T010–T012)**.

## Implementation Strategy

- **Highest risk was T003** (refactoring the conversation store). Landed back-compat migration first and kept the existing desktop e2e green throughout. The agentId-partition follow-up (T013) removed the group field entirely rather than patching around it — simpler model, no dual-field complexity.

## Notes

- Each surface's OWN top-level CopilotKit provider (with NO global provider above it) is the mechanism for agent scoping and conversation partitioning. Nested CopilotKit providers do NOT isolate — an outer provider dominates inner ones (spec Clarifications + FR-006).
- `agentId` is the sole partition key. A `group` field in old conversation JSON files is silently migrated to `agentId` on read and never written.
- Per-embed *action* scoping is out of scope here (the `011` deferral in `TODO.md`).
