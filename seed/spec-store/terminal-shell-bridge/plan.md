# Implementation Plan: Terminal Shell Bridge MCP Server

## 1. Objective
To implement a secure, high-performance **Shell Bridge MCP Server** that enables BrowserOS applications (specifically the Terminal App) to spawn and control interactive shell sessions on the host operating system using `node-pty` and the Model Context Protocol (MCP).

## 2. Scope & Deliverables
### In Scope
- Creation of a new Node.js project at `mcp-servers/shell-bridge/`.
- Implementation of 6 MCP tools: `spawn_shell`, `write_input`, `resize_terminal`, `send_signal`, `kill_session`, `list_sessions`.
- Implementation of 2 MCP events: `onData`, `onExit`.
- Security layer: Session limits, idle timeouts, and input validation.
- Unit and integration tests for core logic.
- Integration with BrowserOS MCP registry.

### Out of Scope (Future Iterations)
- Web-based terminal frontend (handled by the separate Terminal App).
- Remote WebSocket transport (stdio only for now).
- Sudo password prompting UI.
- File transfer protocols (SCP/SFTP).

## 3. Execution Strategy

### Phase 1: Environment & Branching (Immediate)
**Goal:** Isolate work and prepare the build environment.
1.  **Create Feature Branch**:
    - Command: `git checkout -b bos/terminal-shell-bridge`
2.  **Initialize Project**:
    - Create directory `mcp-servers/shell-bridge/`.
    - Initialize `package.json` with dependencies:
      - `@modelcontextprotocol/sdk` (MCP protocol)
      - `node-pty` (Cross-platform PTY)
      - `uuid` (Session IDs)
      - `zod` (Schema validation)
      - `typescript`, `tsx` (Build tools)
3.  **Configure TypeScript**: Set up `tsconfig.json` with strict mode and ES2022 target.

### Phase 2: Core Implementation (Delegated to Sub-Agent)
**Goal:** Write the server code based on `design.md`.
*The following tasks will be assigned to a Claude Developer Sub-Agent:*

1.  **Project Skeleton**:
    - Create file structure: `src/index.ts`, `src/server.ts`, `src/router.ts`, `src/session-manager.ts`, `src/pty-factory.ts`, `src/data-emitter.ts`, `src/security.ts`.
2.  **PTY Factory (`pty-factory.ts`)**:
    - Implement `spawnShell(options)` function using `node-pty.spawn()`.
    - Handle environment variable merging (`process.env` + user overrides).
    - Ensure `TERM=xterm-256color` is set.
3.  **Session Manager (`session-manager.ts`)**:
    - Implement `SessionStore` (Map<UUID, ShellSession>).
    - Implement `createSession()`, `getSession()`, `destroySession()`.
    - Add background cleanup logic for idle sessions (every 60s).
4.  **Data Emitter (`data-emitter.ts`)**:
    - Wire PTY `data` events to MCP `onData` event emission.
    - Implement `writeInput(sessionId, data)` to pipe to PTY stdin.
5.  **Router & Tools (`router.ts`, `server.ts`)**:
    - Define Zod schemas for all 6 tools (from `spec.md`).
    - Register tools with the MCP server instance.
    - Implement error handling wrapper (standardize error codes).
6.  **Security (`security.ts`)**:
    - Implement max session count check.
    - Implement input size limit (64KB).
    - Add optional command filtering stub (for future strict mode).

### Phase 3: Testing & Validation
**Goal:** Verify correctness and stability.
1.  **Unit Tests**:
    - Mock `node-pty` to test session lifecycle logic without spawning real shells.
    - Test schema validation for invalid inputs.
2.  **Integration Tests**:
    - Spawn a real `bash` shell.
    - Execute `echo "hello"`, verify output via `onData`.
    - Resize terminal, verify `SIGWINCH` handling.
    - Send `SIGINT`, verify process exit.
3.  **Manual Smoke Test**:
    - Run `tsx src/index.ts` locally.
    - Connect a simple MCP client (e.g., `mcp-cli` or BrowserOS debug console).
    - Verify interactive programs (`vim`, `top`) work correctly.

### Phase 4: Integration & Deployment
**Goal:** Make the server available to BrowserOS apps.
1.  **Register in BOS**:
    - Update BrowserOS MCP configuration to include `shell-bridge`.
    - Ensure the transport is set to `stdio` pointing to the new binary/script.
2.  **Documentation**:
    - Update `README.md` with installation and usage instructions.
3.  **Merge**:
    - Commit changes, push branch, and request review/merge into main.

## 4. Resource Requirements
- **Developer Agent**: 1 Claude Developer Sub-Agent (for Phase 2).
- **Time Estimate**: 
  - Setup: 15 mins
  - Implementation: 1-2 hours
  - Testing: 30 mins
  - Integration: 15 mins
- **Dependencies**: Node.js v18+, `node-gyp` (for native `node-pty` compilation).

## 5. Risk Management
| Risk | Impact | Mitigation |
|------|--------|------------|
| `node-pty` fails to compile on user's OS | High | Provide pre-built binaries or fallback to a pure JS PTY shim (if available) for testing. Document build requirements clearly. |
| Security bypass via command injection | Critical | Input is passed raw to PTY; rely on OS shell permissions. Add strict resource limits and optional filtering in future. |
| Memory leak from orphaned sessions | Medium | Implement strict idle timeout (5 mins) and periodic cleanup task. |
| Latency in I/O streaming | Low | Use non-blocking streams and direct piping; avoid unnecessary buffering. |

## 6. Success Criteria
- [ ] MCP server starts without errors in `stdio` mode.
- [ ] All 6 tools are callable and return valid JSON responses.
- [ ] Terminal App can spawn a shell, type commands, and see output.
- [ ] Interactive programs (vim, top) render correctly with colors.
- [ ] Sessions are automatically cleaned up after idle timeout.
- [ ] No memory leaks observed during long-running sessions.

## 7. Approval
This plan is approved based on the completed **Specification** (`spec.md`) and **Design** (`design.md`).

**Status:** Ready for Execution.
**Next Action:** Create feature branch `bos/terminal-shell-bridge` and delegate Phase 2 to a sub-agent.
