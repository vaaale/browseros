# Feature Specification: Tool taxonomy, sandboxed command execution, and per-conversation agents

**Feature Branch**: `tools-refactor`

**Created**: 2026-07-03

**Status**: Implemented

**Input**: "Fix the assistant's tooling: give it real skill-support tools, remove duplicate tools, add a safe sandboxed `run_command` (Local + Docker), add read-only source/spec tools, and adopt one coherent naming standard. Also: an agent's personality is per-conversation — there is no single global 'active agent'."

> Completes `016-unified-agents` (one capability registry, one allowlist per agent) and corrects a set of tooling defects found in use: duplicate/inconsistently-named tools, an unsandboxed `runBash`, missing skill file-reading/execution, and a **global active-agent** state variable that leaked one conversation's personality into another. This spec captures the implemented end state.

## Clarifications

### Session 2026-07-03

- Q: One global "active agent" or per-conversation? → A: **Per-conversation.** Each conversation carries its own `agentId`; multiple conversations (even open at once) run different agents independently. There is no global active-agent state.
- Q: What happens if an agent id can't be resolved? → A: **Fail fast** — `composeInstructions(agentId)` throws on an empty id rather than falling back. `DEFAULT_AGENT_ID = "assistant"` is retained ONLY for delete-protection and blank/bootstrap seeding, never as a resolution fallback.
- Q: What backends does `run_command` support? → A: A pluggable interface with **`docker`** (recommended, per-`(session,agent)` container) and **`local`** (host, only sensible when BOS itself runs in a container) now; a `bwrap` backend can slot in later. Off by default.
- Q: How do skill scripts resolve their paths? → A: The skill's bundled files are **staged into the sandbox workspace** (the VFS `/workspace` folder) before the command runs, so a `SKILL.md` command like `python scripts/x.py` resolves as-written.
- Q: What is the tool naming standard? → A: `subsystem_object_verb`, snake_case, **one id per logical operation**. A capability that exists on both surfaces (client action + server sub-agent tool) is a single id with `context: "both"`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Per-conversation personality (Priority: P1)

Two conversations open at once — one on the Developer agent, one on Clark (Office) — each answers as itself, regardless of which was touched last.

**Acceptance Scenarios**:

1. **Given** a Developer conversation and an Office conversation open together, **When** the user asks each "what's your name?", **Then** each answers with its own agent's identity (no cross-contamination).
2. **Given** the "+" on an agent group in the conversation list, **When** a new conversation is started, **Then** it is tagged with that group's agent (not a generic default).

### User Story 2 - One coherent tool inventory (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the capability registry, **When** a developer inspects it, **Then** every tool has a `subsystem_object_verb` id, one id per logical operation, and a `context` of `action`, `tool`, or `both` — no duplicate/legacy names.

### User Story 3 - Sandboxed command execution (Priority: P1)

**Acceptance Scenarios**:

1. **Given** Command Execution enabled with the Docker backend, **When** the agent runs a `python`/`node`/`bash` command, **Then** it executes in a hardened, per-session container whose `/workspace` is the VFS workspace folder, and outputs appear in the Files app.
2. **Given** a skill whose procedure runs a bundled script, **When** the agent runs it via `run_command` with `skill=<id>`, **Then** the skill's files are staged into `/workspace` first and the script's relative paths resolve.
3. **Given** Command Execution disabled (default), **When** the agent tries to run a command, **Then** it is refused.

### User Story 4 - Read-only source & spec access for sub-agents (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a local agent granted the read-only Dev tools, **When** it runs, **Then** it can `bos_source_list`/`bos_source_read`/`bos_source_search` and `dev_git_status` but CANNOT write source (writes remain the Claude/OpenCode harness's job).

### Edge Cases

- A conversation persisted before this change (no `agentId`) MUST still load; it is tagged on load.
- Parallel sub-agents each get their own sandbox container (key `${sessionId}:${agentId}`), so one cannot see another's workspace state.
- Installed packages persist for the life of the session's container, not across restarts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A single **capability registry** (`src/lib/agent/capabilities-registry.ts`) MUST enumerate every tool with `{ id, group, description, context }` where `context ∈ {action, tool, both}`. It is framework-free so client gating, the server tool resolver, the Settings catalog, and the InfoPanel share one list.
- **FR-002**: Tool ids MUST follow `subsystem_object_verb` snake_case with one id per logical operation; a both-surface operation is one id (not a client/server pair).
- **FR-003**: There MUST be no global "active agent" state. Each conversation carries `agentId`; `composeInstructions(agentId)` MUST throw on an empty id (no fallback). `DEFAULT_AGENT_ID` is retained only for delete-protection and blank/bootstrap seeding.
- **FR-004**: New-conversation creation and auto-seed MUST use the agent selected in the Assistant app's agent drop-down (which always has a selection); the "+" on an agent group MUST tag the new conversation with that agent.
- **FR-005**: BOS MUST provide skill-support tools usable in both contexts: `skill_list`, `skill_load`, `skill_read_file` (read a bundled reference/script), plus the existing `skill_save`/`skill_reflect`/`skill_improve`/`skill_curate`.
- **FR-006**: `run_command` MUST replace the unsandboxed `runBash`. It MUST be **off by default**, gated by the `run-command` config namespace (a **Command Execution** Settings tab), and support pluggable backends: **`docker`** (per-`(session,agent)` container; non-root `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges`, pids/memory limits, `--network none` unless enabled; reaped on idle and on server exit) and **`local`** (host, gated behind `enabled`).
- **FR-007**: The sandbox working directory `/workspace` MUST be bind-mounted from a **VFS folder**, so `file_write` and `run_command` share one filesystem and command outputs appear in the Files app. Only `/workspace` (+ a tmpfs `/tmp`) is exposed; other VFS folders are not mounted. Optional extra bind mounts (`ro`/`rw`) are configurable.
- **FR-008**: `run_command` MUST support `language ∈ {bash, python, node}` and a `skill=<id>` argument that stages that skill's bundled files into `/workspace` before running (so `SKILL.md` relative script paths resolve).
- **FR-009**: `run_command` MUST enforce an **idle timeout** (kills a command with no output for N seconds; default 120) and a **max timeout** (hard cap; default 600); settings store seconds, the executor converts to ms. Output is merged (stdout+stderr) and capped.
- **FR-010**: Sub-agents MUST be able to hold read-only repo tools — `bos_source_list`, `bos_source_read`, `bos_source_search`, `dev_git_status` — granted only when listed in the agent's `tools`. Source **writes** are NOT a tool; only the Claude/OpenCode dev harness edits source.
- **FR-011**: A conversation persisted mid-run MUST be sanitized on load (drop trailing unanswered assistant tool-calls; append a settled note if it ends on a tool result) so restoring it starts no run and re-executes nothing (upholds `000` FR-016).
- **FR-012**: CopilotKit **AG-UI shared state** (`AGUISendStateSnapshot`/`AGUISendStateDelta`) MUST be supported as session state and surfaced in the Assistant's **State** tab — not stripped and not rendered as noisy tool-call cards.

### Key Entities

- **Capability** — `{ id, group, description, context: "action"|"tool"|"both" }` in the registry.
- **Sandbox** — a backend-agnostic executor (`src/lib/system/run-command.ts`) keyed by `${sessionId}:${agentId}`; docker containers labeled `bos.run-command`.
- **Sandbox image** — `docker/run-command/Dockerfile` → `browseros/run-command:latest` (Python venv on PATH, Node + `NODE_PATH`, LibreOffice, poppler, `python-pptx`/`pptxgenjs`).
- **Conversation** — carries `agentId`; no global active-agent variable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Two concurrently-open conversations on different agents each answer with their own identity.
- **SC-002**: The registry has no duplicate or non-conforming tool ids; every id is `subsystem_object_verb`.
- **SC-003**: With Command Execution enabled (Docker), a skill script runs in the sandbox with its bundled files present and writes an output visible in the Files app.
- **SC-004**: With Command Execution disabled, no command runs.
- **SC-005**: Reopening a mid-run conversation appends no messages and starts no run.
- **SC-006**: AG-UI shared state appears in the State tab and does not render as a tool-call card.

## Assumptions & Dependencies

- Completes `016-unified-agents` (registry + one-allowlist) and interacts with `011` (per-agent capability scoping), `012` (per-conversation/embedded agent), `003-self-improvement` (skill tools), `006-data-isolation` (VFS workspace).
- Docker is optional; when absent or disabled, `run_command` is unavailable and the rest of BOS is unaffected.

## Notes

- Dev docs: `docs/dev/run-command/run-command.md`. Usage: `docs/usage/settings/command-execution.md`.
- Supersedes the unsandboxed `runBash` tool and the global active-agent state described in earlier specs (`011`, `012`, `016`) — those specs' "active agent" wording is superseded by the per-conversation model here (see `discrepancies.md`).
