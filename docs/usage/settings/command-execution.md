# Command Execution

**Settings → Command Execution** lets the assistant (and its sub-agents) run shell
commands, Python, and Node in a **sandbox** — needed for skills that generate
files (e.g. building a PowerPoint with the `pptx` skill). It's **off by default**.

## Options

- **Enabled** — master switch. Off by default.
- **Backend**
  - **Docker (recommended)** — each browser-session + agent runs in its own
    isolated container (non-root, no network by default), created on first use and
    kept alive for the session.
  - **Local** — runs directly on the host. Only sensible if BOS itself runs inside
    a container.
- **Docker image** — the image used for the sandbox. Default
  `browseros/run-command:latest`, which bundles Python (+ `python-pptx`,
  `markitdown`, `ipython`), Node (+ `pptxgenjs`), LibreOffice, and poppler. Build
  it once with:
  ```
  docker build -t browseros/run-command:latest docker/run-command
  ```
- **Workspace (VFS path)** — the folder mounted as the sandbox's working directory
  (default `/workspace`). **Files the assistant creates here — and command outputs
  — show up in your Files app**, so you can open the results. Only this folder is
  visible to the sandbox.
- **Extra bind mounts** — optional additional host folders (`/path:ro` or
  `/path:rw`, one per line). Leave empty unless you need to share a specific
  directory. Never mount secrets read‑write.
- **Container network** — allow the sandbox network access. Off by default (so
  `pip`/`npm` installs need it on; the default image already has common tools).
- **Idle timeout (seconds)** — kill a command that produces no output for this long
  (default 120).
- **Max timeout (seconds)** — hard cap on a single command (default 600).

## Notes

- Installed packages persist for the life of the session's container, not across
  restarts.
- Because it can run arbitrary code, keep it disabled unless you trust the
  assistant to run commands in this environment.
