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

- [ ] T001 Create the `bos/embeddable-assistant` feature branch (developer).
- [ ] T002 [P] Add `group: string` to the `Conversation` type in `src/lib/agent/conversations.ts`.

---

## Phase 2: Foundational (Blocking — the core refactor)

- [ ] T003 Make `src/lib/agent/conversations.ts` **group-aware**: a `group` field; on-disk layout `/Documents/Chats/<group>/<id>.json` with **back-compat migration** of existing flat files into the `assistant` group; a per-group active id (localStorage keyed by group); and group-scoped APIs (`useConversations(group)`, `useActiveConversationId(group)`, `new/select/delete` per group).
- [ ] T004 Parameterize `src/components/agent/CopilotProvider.tsx` — accept `threadId`/`group` (and an optional pinned agent) instead of hardcoding the global active conversation; keep the `*Actions` registered inside.
- [ ] T005 Key `src/components/agent/ChatPersistence.tsx` by `(group, threadId)` so each group persists to its own files.

**Checkpoint**: conversations partition by group; existing chats still load (migrated).

---

## Phase 3: User Stories 1–3 — Embed, agent scope, chrome (P1)

- [ ] T006 Add `src/components/agent/AssistantChat.tsx` — the embeddable surface: its own `CopilotProvider` over the sub-tree, instructions composed for `agentId` (default = global active), `useChatPersistence` + `ChatToolRenderer`, and chrome props (`group`, `showConversations?`, `showInfo?`).
- [ ] T007 Thread the embed's `agentId` to `/api/copilotkit` so `buildRuntimeOptions(agentId)` scopes MCP (a request header on the embed's `CopilotKit`, read in the route; fall back to `/api/copilotkit?agent=…` if per-provider headers aren't supported — confirm during build).

---

## Phase 4: User Story 4 — Partitioned conversations UI (P1)

- [ ] T008 `src/components/apps/assistant/ConversationPanel.tsx` — add a `group?` prop: unset → list **all** conversations **grouped/nested** (like Docs/Specs); set → only that group's conversations.

---

## Phase 5: User Story 5 — Assistant consumes the embed (P2)

- [ ] T009 Refactor `src/apps/chat/index.tsx` to render `<AssistantChat group="assistant" showConversations showInfo />` (the reference consumer); remove the now-duplicated provider/chat wiring.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T010 [P] Docs: `docs/usage/assistant/*` + `docs/dev/assistant/*` for the embeddable assistant + conversation groups.
- [ ] T011 [P] Tests: the existing desktop e2e (opens the Assistant) must still pass; add an embedded-chat smoke (full coverage lands with `013`, which provides a real embed).
- [ ] T012 Run typecheck + lint to green; `/speckit.analyze` on `012`.

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → **Foundational (T003–T005, blocks everything)** → **Embed (T006–T007)** → **Conversations UI (T008)** → **Assistant consumer (T009)** → **Polish (T010–T012)**.

## Implementation Strategy

- **Highest risk is T003** (refactoring the conversation store). Land the back-compat migration first and keep the existing desktop e2e green throughout. Build the embed (T006) and only then flip the Assistant app to consume it (T009), so the app keeps working at every step.

## Notes

- The per-embed CopilotKit provider over a sub-tree is the mechanism for both agent scoping and conversation partitioning (spec Clarifications).
- Per-embed *action* scoping is out of scope here (the `011` deferral in `TODO.md`).
