# Settings → Dev Harness

The **Dev Harness** controls **how Claude Code runs** for development tasks
(building apps and modifying BOS). All coding in BOS is done by Claude, and this
tab decides *how* Claude is launched.

---

## Modes

- **Claude CLI (headless)** — *default and recommended.* BOS spawns Claude Code
  non‑interactively (`claude -p …`) on the machine hosting BOS, with the BOS repo
  as the working directory. **Claude itself** is the autonomous coder (using its
  own read/edit/write/shell tools); BOS streams its activity into the chat and
  captures the result. Because it runs non‑interactively (permissions skipped), it
  is intended to run in a **sandboxed** environment (e.g. Docker).
  - **Working directory** — where Claude runs (defaults to the BOS repo).
- **MCP stdio (`claude mcp serve`)** — connect to a local Claude Code MCP server.
  - **Command** — the command to spawn (default `claude mcp serve`).
- **MCP HTTP (remote)** / **MCP SSE (remote)** — connect to a remote Claude Code
  harness.
  - **Harness URL** — the server endpoint.

> The **CLI mode is preferred** because it reliably runs Claude as the coder. The
> MCP "Agent" harness can only spawn sub‑agent types that were registered when the
> harness started, so a plain `claude mcp serve` may expose nothing spawnable.

---

## Testing

Use the tab's **Test** action to probe the configured harness (e.g. the CLI
version, or the tools a remote harness exposes) so you know it's reachable before
relying on it.

---

## If it isn't configured

If the harness isn't set up or can't be reached, the assistant will **tell you**
when you ask for a development task, rather than falling back to writing code with
the local model. You can set or change the harness here at any time (it's also part
of the first‑run wizard).

---

## Sandboxing note

Headless CLI mode runs Claude with permissions skipped so it's fully
non‑interactive. Run BOS in a sandbox (e.g. Docker) for development use; combined
with BOS's feature‑branch and (when enabled) version‑isolation safeguards, code
changes stay contained.
