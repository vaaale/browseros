# Implementation Plan: Embeddable Assistant (Integration Plane)

**Branch**: `012-embeddable-assistant` | **Date**: 2026-06-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-embeddable-assistant/spec.md`

## Summary

Extract the chat into a reusable, **agent-scoped `<AssistantChat>` embed** — each
instance mounts its own **top-level** CopilotKit provider (there must be NO
global/app-wide provider; see Design notes), with its own conversation thread,
chrome toggles, and pinned agent. Refactor the Assistant app
to consume it. Conversations are **partitioned by group** (the Assistant shows all
groups nested; an embed shows only its own). `011` already added
`composeInstructions(agentId?)` and `buildRuntimeOptions(agentId?)`.

## Technical Context

**Language/Version**: TypeScript — Next.js (App Router), React, CopilotKit.

**Primary Dependencies**: existing — `@copilotkit/react-core`/`react-ui`, the conversations store, `useChatPersistence`. No new deps.

**Storage**: conversations are JSON files in the VFS at `/Documents/Chats/…`; this adds a **group** partition.

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
├── CopilotProvider.tsx     # EDIT — accept threadId/group (+ optional agent) instead of hardcoding the global active id
└── ChatPersistence.tsx     # EDIT — key persistence by (group, threadId)

src/lib/agent/conversations.ts            # EDIT — group-aware: Conversation.group, /Documents/Chats/<group>/<id>.json, per-group active id + group-scoped hooks
src/components/apps/assistant/ConversationPanel.tsx  # EDIT — `group?` prop: undefined = all conversations grouped (nested, like Docs/Specs); set = only that group
src/apps/chat/index.tsx                   # EDIT — consume <AssistantChat group="assistant" showConversations showInfo /> (reference consumer)
```

**Structure Decision**: `<AssistantChat>` is the single embeddable surface; the Assistant app becomes its first consumer (full chrome, global active agent). `013` embeds it with `agentId="build-studio"`, its own group, and no side panels.

## Design notes

### Embeddable component (`<AssistantChat>`)
Props: `agentId?` (pin agent; default = global active), `group` (conversation partition; default `"assistant"`), `showConversations?`, `showInfo?` (chrome). It renders its **own** `CopilotProvider`, composes instructions for `agentId` via `/api/assistant/agent?agentId=…` (or a small endpoint), and mounts `<CopilotChat>` + `useChatPersistence` + `ChatToolRenderer`. It also wraps the chat in a **per-surface card-collapse scope** (core `FR-007`) so its event-card accordion is independent of other surfaces.

### Per-surface provider — NO global provider
`CopilotProvider` is parameterized by `threadId` (the group's active conversation) and optionally the pinned agent; it registers the `*Actions` inside its sub-tree. **Each chat surface mounts its own provider as a top-level sibling, and there must be NO global/app-wide `<CopilotKit>` provider wrapping them.** Nested CopilotKit providers do NOT isolate — an outer/global provider dominates inner ones, so every surface would share one runtime/thread (the shared-chat bug, observed as a new Assistant conversation also appearing in Build Studio). So the global provider must be **removed from `src/app/page.tsx`**; the Assistant app and every embed are independent sibling providers → no thread/agent cross-talk.

### Conversation partitioning (the core refactor)
`Conversation` gains `group: string`. On disk: `/Documents/Chats/<group>/<id>.json` (existing flat files migrate to the `assistant` group on first load — back-compat). The store exposes **group-scoped** views: `useConversations(group)`, `useActiveConversationId(group)`, and `new/select/delete` scoped to a group, with a per-group active id (localStorage keyed by group). `ConversationPanel` with no `group` lists **all groups, nested**; with a `group` lists only that one.

### Runtime agent threading (design item to resolve in build)
Instructions are passed client-side (the `instructions` prop), so agent personality/skills scope correctly per embed. **MCP scoping** is server-side in `buildRuntimeOptions(activeAgent)` — the embed's pinned agent isn't known to `/api/copilotkit` today. Thread the embed's `agentId` to the runtime (e.g. a request header set on the embed's `CopilotKit`/`runtimeUrl`, read in the route → `buildRuntimeOptions(agentId)`). Confirm CopilotKit lets us set per-provider request headers during the build; if not, fall back to a per-embed runtime URL (`/api/copilotkit?agent=…`).

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|-----------|------------|--------------------------------------|
| Refactoring the core chat (`conversations.ts`, `CopilotProvider`) | Embedding + partitioning require the thread/group to be parameterized rather than a single global | Copying the chat per app (the original idea) would duplicate the most complex code and diverge; the user explicitly wants the Assistant reused as a platform primitive |

## Out of scope

`013` (Build Studio consuming the embed); per-embed *action* scoping (the `011` deferral in `TODO.md`); multi-user conversation sharing.
