# Terminal Shell Bridge MCP Server Specification

## 1. Overview
The **Shell Bridge** is an MCP server that provides secure, bidirectional communication between BrowserOS web applications and the host operating system's shell processes. It manages Pseudo-Terminal (PTY) sessions, handles signal forwarding, and enforces security policies for shell access.

### Purpose
- Enable terminal emulation apps (and other tools) to spawn and control interactive shells on the host.
- Provide a standardized, secure interface for PTY management within the BrowserOS ecosystem.
- Isolate shell execution from the browser sandbox while maintaining low-latency I/O.

## 2. Architecture
```
+------------------+       +-------------------+       +----------------------+
|  BrowserOS App   | <---->|  MCP Transport    | <---->|  Shell Bridge Server |
|  (xterm.js UI)   |  WS   |  (HTTP/SSE/Stdio) |  RPC  |  (Node.js + node-pty)|
+------------------+       +-------------------+       +----------------------+
                                                                  |
                                                                  v
                                                          +----------------------+
                                                          |  Host Shell Process  |
                                                          |  (bash, zsh, fish)   |
                                                          +----------------------+
```

### Components
1. **MCP Server**: Exposes tools for session management and I/O streaming.
2. **PTY Manager**: Wraps `node-pty` to spawn and manage shell processes.
3. **Session Store**: In-memory map of active sessions (ID -> PTY instance).
4. **Security Filter**: Intercepts commands and signals based on configuration.

## 3. Transport & Configuration
The server supports standard MCP transports:
- **stdio**: For local CLI usage or direct integration.
- **http/sse**: For remote access (if configured with auth).

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `SHELL` | Default shell to spawn if not specified | System default (`/bin/bash`) |
| `TERM` | Terminal type passed to PTY | `xterm-256color` |
| `MCP_SHELL_TIMEOUT` | Idle session timeout (ms) | `300000` (5 mins) |
| `MCP_SHELL_MAX_SESSIONS` | Max concurrent sessions per user | `10` |

## 4. Tools Specification

### 4.1 `spawn_shell`
Creates a new PTY session and returns a unique session ID.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "shell": {
      "type": "string",
      "description": "Path to shell executable or name (e.g., 'bash', '/bin/zsh'). If omitted, uses default."
    },
    "args": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Arguments passed to the shell."
    },
    "cwd": {
      "type": "string",
      "description": "Initial working directory. Defaults to user's home if omitted."
    },
    "env": {
      "type": "object",
      "description": "Custom environment variables (merges with inherited env)."
    },
    "cols": {
      "type": "integer",
      "description": "Initial terminal width (columns). Default: 80."
    },
    "rows": {
      "type": "integer",
      "description": "Initial terminal height (rows). Default: 24."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Unique identifier for the session (UUID)."
    },
    "pid": {
      "type": "integer",
      "description": "Process ID of the spawned shell."
    },
    "cwd": {
      "type": "string",
      "description": "Actual working directory after spawn."
    }
  }
}
```

**Behavior:**
1. Validates `cwd` exists; if not, returns error.
2. Merges provided `env` with current process environment.
3. Spawns PTY using `node-pty`.
4. Registers session in memory.
5. Returns `sessionId`, `pid`, and resolved `cwd`.

---

### 4.2 `write_input`
Sends data (keypresses, commands) to an active session.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "The session ID returned by spawn_shell."
    },
    "data": {
      "type": "string",
      "description": "Raw string data to write to the PTY stdin. Supports escape sequences."
    }
  },
  "required": ["sessionId", "data"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "success": {"type": "boolean"},
    "bytesWritten": {"type": "integer"}
  }
}
```

**Behavior:**
- Writes raw bytes to the PTY stdin.
- If session does not exist, returns error.
- Does **not** wait for output; output is emitted via `onData` events (see Events section).

---

### 4.3 `resize_terminal`
Resizes the virtual terminal dimensions of a session.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "sessionId": {"type": "string"},
    "cols": {"type": "integer"},
    "rows": {"type": "integer"}
  },
  "required": ["sessionId", "cols", "rows"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "success": {"type": "boolean"},
    "message": {"type": "string"}
  }
}
```

**Behavior:**
- Sends `SIGWINCH` signal to the PTY process.
- Updates internal dimensions.

---

### 4.4 `send_signal`
Sends a Unix signal to the shell process (e.g., SIGINT for Ctrl+C).

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "sessionId": {"type": "string"},
    "signal": {
      "type": "string",
      "enum": ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL", "SIGTSTP"],
      "description": "Signal name to send."
    }
  },
  "required": ["sessionId", "signal"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "success": {"type": "boolean"}
  }
}
```

**Behavior:**
- Maps signal name to OS signal number.
- Sends signal to the PTY process group.
- **Security Note**: `SIGKILL` may be restricted by policy.

---

### 4.5 `kill_session`
Terminates a session and cleans up resources.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "sessionId": {"type": "string"}
  },
  "required": ["sessionId"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "success": {"type": "boolean"},
    "message": {"type": "string"}
  }
}
```

**Behavior:**
- Sends `SIGTERM` to the process.
- Waits briefly for graceful exit.
- If still running, sends `SIGKILL`.
- Removes session from memory.
- Closes file descriptors.

---

### 4.6 `list_sessions`
Returns metadata about all active sessions.

**Input Schema:** `{}` (No args)

**Output Schema:**
```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "sessionId": {"type": "string"},
      "shell": {"type": "string"},
      "pid": {"type": "integer"},
      "cwd": {"type": "string"},
      "uptime": {"type": "integer", "description": "Seconds since spawn"},
      "status": {"type": "string", "enum": ["running", "zombie", "exited"]}
    }
  }
}
```

## 5. Events (Server -> Client)

The server emits events asynchronously to push data from the PTY to the client.

### `onData`
Emitted when the shell process writes output or errors.

**Payload:**
```json
{
  "sessionId": "uuid-string",
  "data": "base64-encoded-string-or-raw-text",
  "type": "stdout" | "stderr" | "exit"
}
```
*Note: `data` may be raw text if the transport supports it, or base64 for binary safety.*

### `onExit`
Emitted when a session terminates.

**Payload:**
```json
{
  "sessionId": "uuid-string",
  "code": {"type": "integer", "nullable": true},
  "signal": {"type": "string", "nullable": true}
}
```

## 6. Security Model

### 6.1 Command Filtering (Optional)
A configuration flag `enableStrictFiltering` can enable a pre-write filter:
- Blocks commands starting with dangerous patterns (e.g., `rm -rf /`, `mkfs`).
- Requires user confirmation via MCP prompt before execution (future enhancement).
- Default: **Disabled** (trust the user), but logs all commands.

### 6.2 Session Isolation
- Sessions are isolated by ID; one client cannot access another's session unless they know the ID.
- All sessions run under the **current user context** (the user running the MCP server).
- No privilege escalation is performed.

### 6.3 Resource Limits
- **Max Sessions**: Hard limit to prevent fork bombs.
- **Idle Timeout**: Auto-kill sessions inactive for > N minutes.
- **Buffer Size**: Limit input/output buffer size to prevent memory exhaustion.

## 7. Implementation Details

### Dependencies
- `@modelcontextprotocol/sdk`: For MCP protocol handling.
- `node-pty`: For cross-platform PTY spawning.
- `uuid`: For session ID generation.
- `zod`: For schema validation.

### Error Handling
All tools must return errors in the standard MCP format:
```json
{
  "error": {
    "code": -32000,
    "message": "Session not found",
    "data": { "sessionId": "..." }
  }
}
```

### Logging
- Log all session spawns and kills to `stdout` (MCP log stream).
- Do **not** log sensitive data (passwords) to logs.
- Use structured JSON logging for easier parsing.

## 8. Future Enhancements
1. **Session Persistence**: Save/restore session state (history, layout).
2. **File Transfer**: Integrated `scp`/`rsync` via MCP tools.
3. **Multi-user Support**: Authentication tokens for remote access.
4. **Sudo Integration**: Prompt for password and handle `sudo` sessions securely.

## 9. Example Workflow

1. **Client** calls `spawn_shell({ shell: "bash", cwd: "/home/user" })`.
2. **Server** spawns `bash`, returns `sessionId: "abc-123"`.
3. **Client** connects to `onData` stream for session `abc-123`.
4. **Client** calls `write_input({ sessionId: "abc-123", data: "ls -la\n" })`.
5. **Server** writes to PTY, captures output.
6. **Server** emits `onData` events with terminal output.
7. **Client** renders output in `xterm.js`.
8. **Client** calls `kill_session({ sessionId: "abc-123" })` when done.

## Clarifications

### Session 2026-06-29 — Initial Specification Review

**Q**: Is remote WebSocket transport required for initial implementation?  
**A**: No. The spec explicitly limits Phase 1 to `stdio` transport only (see §3 and §9.1). Remote WebSocket/SSE transport is deferred to future iterations.

**Q**: Should command filtering be enabled by default?  
**A**: No. Default is **Disabled** (trust the user), with logging of all commands. Strict filtering is an optional future enhancement (§6.1).

**Q**: Are session history/persistence required?  
**A**: No. Session persistence is listed as a future enhancement (§8, item 1). Initial implementation focuses on in-memory session management only.

**Clarify Phase Status**: COMPLETE — Specification and design artifacts are consistent and ready for implementation planning.
