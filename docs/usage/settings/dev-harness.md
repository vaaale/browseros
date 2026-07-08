# Settings → Dev Harness

The **Dev Harness** controls **how the developer agent runs** for development tasks
(building apps and modifying BOS). All coding in BOS is done by an autonomous coding
agent — Claude Code or OpenCode — and this tab decides *which* one and *how* it is
launched.

---

## Modes

- **Claude CLI (headless)** — *default and recommended.* BOS spawns Claude Code
  non‑interactively (`claude -p …`) on the machine hosting BOS, with the BOS repo
  as the working directory. **Claude itself** is the autonomous coder (using its
  own read/edit/write/shell tools); BOS streams its activity into the chat and
  captures the result. Because it runs non‑interactively (permissions skipped), it
  is intended to run in a **sandboxed** environment (e.g. Docker).
- **OpenCode CLI (headless)** — a provider‑agnostic alternative that spawns OpenCode
  non‑interactively (`opencode run … --format json --dir <worktree> --auto`) in the
  BOS repo or Supervisor preview worktree. **OpenCode itself** is the autonomous
  coder; BOS streams its tool activity and captures the result, exactly like the
  Claude CLI. OpenCode uses its **own** provider/model auth (configure it via
  OpenCode, e.g. `opencode auth login` or its config), independent of the BOS
  AI‑provider setting. Same sandbox advice.
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

Use the tab's **Test** action to probe the configured harness — for CLI modes it
checks the selected binary (`claude --version` or `opencode --version`); for MCP
modes it lists the tools a remote harness exposes — so you know it's reachable before
relying on it.

---

## If it isn't configured

If the harness isn't set up or can't be reached, the assistant will **tell you**
when you ask for a development task, rather than falling back to writing code with
the local model. You can set or change the harness here at any time (it's also part
of the first‑run wizard).

---

## Sandboxing note

Headless CLI mode runs the coder (Claude or OpenCode) with permissions skipped so
it's fully non‑interactive. Run BOS in a sandbox (e.g. Docker) for development use;
combined with BOS's feature‑branch and (when enabled) version‑isolation safeguards,
code changes stay contained.

For BOS source edits, version isolation is mandatory: the Developer harness refuses
to run unless the Supervisor can provision an isolated feature-branch worktree. Run
BOS with `npm run supervisor` for self-modification work.
