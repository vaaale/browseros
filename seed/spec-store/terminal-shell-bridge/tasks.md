---
description: "Task list for Terminal Shell Bridge MCP Server"
---

# Tasks: Terminal Shell Bridge

**Input**: Design documents from `/specs/terminal-shell-bridge/`

**Prerequisites**: plan.md (required), spec.md (required), design.md (required)

**Tests**: Included — Unit and integration tests for PTY management and MCP protocol handling.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: the user story a task serves (US1–US2)

---

## Phase 1: Setup

- [ ] T001 Create the `bos/terminal-shell-bridge` feature branch (developer, via `git_branch`).
- [ ] T002 [P] Initialize project at `mcp-servers/shell-bridge/` with `package.json`, `tsconfig.json`.
- [ ] T003 [P] Add dependencies: `@modelcontextprotocol/sdk`, `node-pty`, `uuid`, `zod`, `tsx`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ Blocks all user stories.**

- [ ] T004 Implement `src/types.ts` — TypeScript interfaces (`ShellSession`, `BridgeError`, tool input/output schemas).
- [ ] T005 Implement `src/pty-factory.ts` — `spawnShell(options)` using `node-pty`, env merging, `TERM=xterm-256color`.
- [ ] T006 Implement `src/session-manager.ts` — `SessionStore` (Map), `createSession()`, `getSession()`, `destroySession()`, idle cleanup (60s interval).
- [ ] T007 Implement `src/security.ts` — max session check, input size limit (64KB), optional command filtering stub.
- [ ] T008 Implement `src/router.ts` — Zod schema validation for all 6 tools, request routing.

**Checkpoint**: Core infrastructure ready - MCP tools can now be wired.

---

## Phase 3: User Story 1 — Shell Session Management (P1) 🎯 MVP

**Goal**: Spawn, manage, and terminate PTY sessions via MCP tools.

- [ ] T009 [P] [US1] Implement `spawn_shell` tool in `src/server.ts` (uses `pty-factory`, stores in `session-manager`).
- [ ] T010 [P] [US1] Implement `kill_session` tool in `src/server.ts` (graceful terminate, cleanup).
- [ ] T011 [P] [US1] Implement `list_sessions` tool in `src/server.ts` (returns metadata array).
- [ ] T012 [US1] Wire `onExit` MCP event emission from PTY exit listeners.

**Checkpoint**: Sessions can be spawned, listed, and killed.

---

## Phase 4: User Story 2 — Interactive I/O Streaming (P1) 🎯 MVP

**Goal**: Bidirectional terminal I/O with resize and signal support.

- [ ] T013 [P] [US2] Implement `write_input` tool in `src/server.ts` (writes to PTY stdin, updates `lastActivity`).
- [ ] T014 [P] [US2] Implement `resize_terminal` tool in `src/server.ts` (calls `pty.resize()`, sends `SIGWINCH`).
- [ ] T015 [P] [US2] Implement `send_signal` tool in `src/server.ts` (maps signal names, sends to process group).
- [ ] T016 [US2] Wire `onData` MCP event emission from PTY `data` listeners (base64 or raw text).

**Checkpoint**: Full terminal interaction loop works (spawn → write → read → resize → signal → kill).

---

## Phase 5: Testing & Validation

- [ ] T017 [P] Unit tests for `session-manager.ts` (mock `node-pty`) in `tests/unit/session-manager.test.ts`.
- [ ] T018 [P] Unit tests for `security.ts` (resource limits, input validation) in `tests/unit/security.test.ts`.
- [ ] T019 Integration test: spawn bash, execute `echo "hello"`, verify `onData` output in `tests/integration/io.test.ts`.
- [ ] T020 Integration test: resize terminal, verify `SIGWINCH` handling in `tests/integration/resize.test.ts`.
- [ ] T021 Integration test: send SIGINT, verify process exit in `tests/integration/signals.test.ts`.
- [ ] T022 Manual smoke test: run `tsx src/index.ts`, connect MCP client, test interactive programs (`vim`, `top`).

---

## Phase 6: Integration & Deployment

- [ ] T023 Register `shell-bridge` in BrowserOS MCP configuration (Settings → MCP Servers).
- [ ] T024 Add `README.md` with installation and usage instructions.
- [ ] T025 Run `npm run typecheck` and `npm run lint`; fix any errors.
- [ ] T026 Commit changes, push branch, request merge into main.

---

## Dependencies & Execution Order

- **Setup (T001–T003)** → **Foundational (T004–T008, blocks everything)** → **US1 (T009–T012)** → **US2 (T013–T016)** → **Testing (T017–T022)** → **Deployment (T023–T026)**.
- US1 and US2 can run in parallel after Foundational phase.
- **Parallel**: `[P]` tasks touch different files — T002, T003, T004, T007, T009–T015, T017–T021 can overlap within their phase windows.

## Implementation Strategy

- **MVP** = Setup + Foundational + US1 + US2: a working terminal bridge.
- Testing validates correctness before deployment.
- Delegate implementation to Developer sub-agent after branch creation.

## Notes

- `[P]` = different files, no dependencies. `[Story]` maps a task to a user story for traceability.
- All tools must return errors in standard MCP format (see `spec.md` §6).
- Log all session spawns/kills to stdout; never log sensitive data.
- Commit after each logical group; keep changes reversible on the feature branch.
