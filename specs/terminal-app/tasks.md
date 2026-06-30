---
description: "Task list for Terminal App Frontend"
---

# Tasks: Terminal App Frontend

**Input**: Design documents from `/specs/terminal-app/`

**Prerequisites**: spec.md (required), Shell Bridge MCP Server (required)

**Tests**: Manual testing via BrowserOS; integration tests with Shell Bridge.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: the user story a task serves (US1–US5)

---

## Phase 1: Setup

- [ ] T101 Create the `bos/terminal-app` feature branch (developer, via `git_branch`).
- [ ] T102 [P] Initialize app project at `apps/terminal/` with React + Vite setup.
- [ ] T103 [P] Add dependencies: `xterm`, `xterm-addon-fit`, `xterm-addon-web-links`, `xterm-addon-search`, `zustand`, `@modelcontextprotocol/sdk`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ Blocks all user stories.**

- [ ] T104 Implement `src/types.ts` — TypeScript interfaces for sessions, tabs, panes, and MCP client state.
- [ ] T105 Implement `src/mcp-client.ts` — Lightweight MCP client wrapper for Shell Bridge connection and tool calls.
- [ ] T106 Implement `src/store/session-store.ts` — Zustand store for managing tabs, panes, and session IDs.
- [ ] T107 Implement `src/components/TerminalEmulator.tsx` — xterm.js wrapper component with fit addon.
- [ ] T108 Implement `src/hooks/useTerminalSession.ts` — Hook to manage PTY lifecycle for a single pane.

**Checkpoint**: Core infrastructure ready - can spawn sessions and render terminals.

---

## Phase 3: User Story 1 — Basic Terminal Interaction (P1) 🎯 MVP

**Goal**: Spawn shell sessions and display output in real-time.

- [ ] T109 [P] [US1] Implement session spawn logic on app init or "New Tab" click.
- [ ] T110 [P] [US1] Wire `onData` events to xterm.js `write()` method.
- [ ] T111 [P] [US1] Handle keypresses: capture input and call `write_input` MCP tool.
- [ ] T112 [US1] Add ANSI color support via xterm.js default configuration.

**Checkpoint**: Users can type commands and see output.

---

## Phase 4: User Story 2 — Session Management (P1) 🎯 MVP

**Goal**: Multiple tabs with independent shell sessions.

- [ ] T113 [P] [US2] Implement tab bar component with "New Tab" button and close buttons.
- [ ] T114 [P] [US2] Add keyboard shortcuts: Cmd+T (new tab), Cmd+W (close tab).
- [ ] T115 [P] [US2] Implement tab switching logic (click or Ctrl+Tab).
- [ ] T116 [US2] Call `kill_session` MCP tool when closing a tab.
- [ ] T117 [US2] Add tab renaming feature (default: current directory from shell prompt).

**Checkpoint**: Multiple tabs work, sessions cleaned up on close.

---

## Phase 5: User Story 3 — Split Panes (P2)

**Goal**: Horizontal and vertical split panes within a tab.

- [ ] T118 [P] [US3] Implement pane container component with resizeable dividers.
- [ ] T119 [P] [US3] Add "Split Horizontally" and "Split Vertically" context menu items.
- [ ] T120 [P] [US3] Implement drag-to-resize functionality for pane dividers.
- [ ] T121 [US3] Call `kill_session` when closing a specific pane.
- [ ] T122 [US3] Add keyboard shortcut for splitting (e.g., Cmd+\).

**Checkpoint**: Users can split panes and resize them.

---

## Phase 6: User Story 4 — Customization & Appearance (P2)

**Goal**: Theme, font, and opacity settings.

- [ ] T123 [P] [US4] Create settings panel component (modal or slide-out).
- [ ] T124 [P] [US4] Implement theme selector with predefined color schemes (BOS Default, Dracula, Monokai, Solarized).
- [ ] T125 [P] [US4] Add font family and size controls.
- [ ] T126 [P] [US4] Implement background opacity slider.
- [ ] T127 [US4] Persist settings to BrowserOS settings storage.
- [ ] T128 [US4] Apply theme changes dynamically without reloading.

**Checkpoint**: Users can customize terminal appearance.

---

## Phase 7: User Story 5 — BrowserOS Integration (P2)

**Goal**: Drag-and-drop, window controls, and BOS consistency.

- [ ] T129 [P] [US5] Implement drag-and-drop handler for file paths from Files app.
- [ ] T130 [P] [US5] Convert dropped paths to absolute paths and insert into terminal.
- [ ] T131 [P] [US5] Ensure BOS window controls (minimize, maximize, close) work correctly.
- [ ] T132 [US5] Add right-click context menu: Copy, Paste, Clear, Split, New Tab, Settings.
- [ ] T133 [US5] Override browser defaults for Ctrl+Shift+C/V (copy/paste).

**Checkpoint**: Seamless integration with BrowserOS environment.

---

## Phase 8: Testing & Error Handling

- [ ] T134 [P] Handle connection lost scenario: show "Reconnecting..." overlay with retry.
- [ ] T135 [P] Handle session spawn failure: display error message in terminal area.
- [ ] T136 [P] Implement `onExit` event handling: show "Process exited" message.
- [ ] T137 Manual test: Verify all keyboard shortcuts work correctly.
- [ ] T138 Manual test: Test with interactive programs (vim, top, htop).
- [ ] T139 Manual test: Test drag-and-drop from Files app.
- [ ] T140 Manual test: Verify theme changes apply dynamically.

---

## Phase 9: Integration & Deployment

- [ ] T141 Register `terminal` app in BrowserOS app manifest.
- [ ] T142 Add app icon to dock (SVG or PNG).
- [ ] T143 Update BrowserOS settings to include Terminal configuration options.
- [ ] T144 Run `npm run typecheck` and `npm run lint`; fix any errors.
- [ ] T145 Commit changes, push branch, request merge into main.

---

## Dependencies & Execution Order

- **Setup (T101–T103)** → **Foundational (T104–T108, blocks everything)** → **US1 (T109–T112)** → **US2 (T113–T117)** → **US3 (T118–T122)** → **US4 (T123–T128)** → **US5 (T129–T133)** → **Testing (T134–T140)** → **Deployment (T141–T145)**.
- US1 and US2 are P1 (MVP); US3–US5 are P2 (enhancements).
- **[P]** tasks touch different files — can overlap within their phase windows.

## Implementation Strategy

- **MVP** = Setup + Foundational + US1 + US2: basic terminal with tabs.
- **Full Feature** = MVP + US3 (split panes) + US4 (customization) + US5 (integration).
- Testing validates correctness before deployment.
- Delegate implementation to Developer sub-agent after branch creation.

## Notes

- Use Tailwind CSS for styling (consistent with BOS design language).
- xterm.js addons: `fit` (auto-resize), `web-links` (clickable URLs), `search` (Ctrl+F).
- Session IDs from Shell Bridge must be unique per pane/tab.
- Commit after each logical group; keep changes reversible on the feature branch.
