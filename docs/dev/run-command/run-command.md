# Command execution (`run_command`)

Sandboxed shell/code execution for the assistant and sub-agents. Replaces the old
unsandboxed `runBash` tool. Off by default; enabled in **Settings → Command
Execution** (the `run-command` config namespace).

Implementation: `src/lib/system/run-command.ts`. Tool id: `run_command`
(`context: "both"`).

## Backends

- **`docker` (recommended):** each `(browser-session, agent)` gets its own
  long-lived container, started on first use and kept alive for the session,
  reaped after ~15 min idle. Commands run via `docker exec`. Hardening: non-root
  `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--pids-limit`, `--memory`, `--network none` (unless enabled). Containers are
  labeled `bos.run-command` and torn down on server exit (`installShutdownHooks`).
- **`local`:** runs directly on the host — only sensible when BOS *itself* runs in
  a container. No rootfs isolation; still gated behind `enabled`.

A `bwrap` (unprivileged Linux namespaces) backend can slot in behind the same
interface later.

## Workspace = the VFS

The container's `/workspace` is bind-mounted from a **VFS folder** (default VFS
path `/workspace` → `data/vfs/workspace`, resolved via `os/vfs.ts` `hostPath()`).
So files the agent writes (via `file_write` to that path or via the sandbox) and
command **outputs** appear in the **Files app**, and `file_write` + `run_command`
share one filesystem. Only `/workspace` (+ a tmpfs `/tmp`) exist in the sandbox —
other VFS folders like `/Documents` are NOT mounted.

## Languages & skill scripts

`language`: `bash` (`bash -lc`, default), `python` (`ipython -c`), `node`
(`node -e`). Pass **`skill=<id>`** to stage that skill's bundled files into
`/workspace` first, so a `SKILL.md` command like `python scripts/office/unpack.py`
resolves as-written (see `stageSkillFiles` in `skills/store.ts`).

## Watchdogs

- **Idle timeout** (default 120s): kills a command that produces no output for that
  long (catches hangs while allowing long-but-progressing work).
- **Max timeout** (default 600s): hard cap on total runtime.
- Output is merged (stdout+stderr) and capped (~8 MB buffered, tail truncated).

Settings store timeouts in **seconds**; the executor converts to ms.

## Surfaces & session key

- **Main chat:** `RunCommandActions.tsx` → `POST /api/system/run-command` with the
  browser session id (`getSessionId()`) + `agentId`; sandbox key = `${session}:${agent}`.
- **Sub-agents:** `run_command` is injected **per delegated run** in `runner.ts`
  (`makeRunCommandTool`) with `${getLogContext().sessionId}:${agentId}` — so
  parallel sub-agents get separate containers.

## The sandbox image

`docker/run-command/Dockerfile` builds `browseros/run-command:latest` (the default
image): Debian + a Python **virtualenv** on PATH (so `pip install` works without
PEP 668) with `ipython`/`markitdown[pptx]`/`Pillow`/`python-pptx`, Node +
`pptxgenjs`, LibreOffice, and poppler. `NODE_PATH` is set so `require('pptxgenjs')`
resolves for scripts in `/workspace`. Build:

```
docker build -t browseros/run-command:latest docker/run-command
```

The image must carry whatever runtimes your skills need; point Settings → Command
Execution → Docker image at a custom image if you need more.
