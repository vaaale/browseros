---
description: "Task list for Per-Agent Capabilities (011-per-agent-capabilities)"
---

# Tasks: Per-Agent Capabilities (Tools, Skills, MCP)

**Input**: Design documents from `/specs/011-per-agent-capabilities/`

**Prerequisites**: plan.md, spec.md

**Tests**: Included — BOS's constitution requires typecheck/lint and Playwright self-tests for promotable source changes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: the user story a task serves (US1–US3)

---

## Phase 1: Setup

- [ ] T001 Create the `bos/per-agent-capabilities` feature branch (developer, `git_branch`).
- [ ] T002 [P] Extend `SubAgent` in `src/lib/agent/subagents/types.ts` with `skills?: string[]` and `mcp?: string[]`.

---

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T003 Add `src/lib/agent/capabilities.ts` — resolve an agent's effective `{ tools, skills, mcp }` against the live catalogs; unset/empty = all. Single source of truth.
- [ ] T004 Update `src/lib/agent/subagents/store.ts` — read/write `skills` + `mcp` frontmatter (via `asList`/`buildFrontmatter`); give built-in agents sensible default scopes through the existing additive ensure-exists pass (don't clobber user edits).
- [ ] T005 Update `src/app/api/assistant/agent/route.ts` — return each agent's tools/skills/mcp allowlists **and** a catalog of available tools/skills/MCP for the UI; accept allowlist updates (PATCH).

**Checkpoint**: capability data persists and is served.

---

## Phase 3: User Story 1 — Scope an agent's capabilities in Settings (P1) 🎯 MVP

- [ ] T006 [US1] Extend `src/components/apps/settings/AssistantTab.tsx` — per-selected-agent grouped multi-selects for tools / skills / MCP, populated from the catalog, saved via the API.

**Checkpoint**: a user can restrict an agent's capabilities from Settings.

---

## Phase 4: User Story 2 — The agent honors its scope (P1)

- [ ] T007 [US2] `src/lib/agent/instructions.ts` — `composeInstructions(agentId?)` filters the skills index by the (active or given) agent's allowed skills.
- [ ] T008 [US2] `src/lib/agent/runtime.ts` — `buildRuntimeOptions` includes only the active agent's allowed MCP servers (per-request, so Settings changes apply live).
- [ ] T009 [US2] Add `src/components/agent/AgentCapabilities.tsx` (client context: active agent's allowed action ids) + `useGatedAction.ts`; route every `*Actions.tsx` registration through the gate.
- [ ] T010 [P] [US2] `src/components/apps/assistant/InfoPanel.tsx` — show the active agent's effective tools/skills/MCP.

**Checkpoint**: a scoped agent only sees/uses its allowed tools, skills, and MCP.

---

## Phase 5: User Story 3 — Sensible built-in defaults (P2)

- [ ] T011 [US3] Seed default scopes for built-in agents (e.g. Build Studio = spec tools + the Build Studio skill, no MCP; Developer = dev tools) via the additive seed; verify unset = all for user agents.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T012 [P] Docs: update `docs/usage/assistant/agents-and-personalities.md` + `docs/dev/assistant/*` for per-agent capabilities and the Settings UI.
- [ ] T013 [P] Tests: unit for `capabilities.ts` (unset = all; filtering correctness) + a Playwright e2e (scope an agent in Settings; verify a disallowed tool/skill is absent for that agent).
- [ ] T014 Run typecheck + lint to green; run `/speckit.analyze` on `011`.

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → **Foundational (T003–T005, blocks the rest)** → **US1 (T006)** → **US2 (T007–T010)** → **US3 (T011)** → **Polish (T012–T014)**.
- US2's skills (T007), MCP (T008), and tools (T009) enforcement are independent files and can proceed in parallel after Foundational.

## Implementation Strategy

- **MVP** = Setup + Foundational + US1 + the skills/MCP enforcement of US2 (server-side, low-risk). The main-chat action gating (T009) is the highest-risk piece (touches many `*Actions`); land it behind the `useGatedAction` wrapper and verify nothing regresses for an unset (full-access) agent first.
- Built by the Developer on the `bos/per-agent-capabilities` branch.

## Notes

- Unset/empty allowlist MUST mean full access at every enforcement point (no regression).
- Confirm whether `@copilotkit/react-core` exposes an action `available` flag; if so, prefer it over conditional registration in T009.
