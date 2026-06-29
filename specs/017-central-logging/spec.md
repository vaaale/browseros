# Feature Specification: Central Logging (timeline-first, Supervisor-collected)

**Feature Branch**: `017-central-logging`

**Created**: 2026-06-29

**Status**: Draft

**Input**: User description: "Add proper logging on the backend and the frontend that sends log messages to the server. All core system functions emit log messages into a central logging system, partitioned by session id. Motivating failure: a preview build failed during self-modification and there was no way to see why; switching back also seemed broken — so the Supervisor logic must be logged. Suggest separate frontend, backend, and supervisor logs. Session = the browser session id (a new browser → a new session id). Log messages are sent to the Supervisor process, since it is the single always-on trusted kernel of BOS."

> Pairs with `005-self-modification` (the Supervisor that becomes the log sink) and `006-data-isolation` (canonical data, where the store lives). The Supervisor remains the **trusted kernel**: dependency-light (Node built-ins only) and **not** self-modified, so its logging is self-contained and does not import BOS source.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See *why* a preview build failed (Priority: P1)

A self-modification finishes, the new version builds for testing, and the build fails. The user can read the **actual build output** (compiler/lint/Next errors) instead of a generic failure.

**Why this priority**: This is the motivating pain. Today `buildAndStart()` runs `npm run build` via `execFile`, and on failure the `/build` handler returns only `String(e.message)` (a generic "Command failed"); the real output in `e.stdout`/`e.stderr` is discarded. The failure is a black box.

**Independent Test**: Trigger a preview build that fails to compile; confirm the toolbar shows the real error reason and the full output is persisted to its build log.

**Acceptance Scenarios**:

1. **Given** a preview whose `npm run build` fails, **When** the build runs, **Then** the Supervisor captures the full stdout+stderr to a referenced blob (`logs/builds/<branch>-<ts>.log`) linked from the timeline, sets the preview `state:"failed"` with the captured error tail as the reason, and returns that reason from `POST /__supervisor/build`.
2. **Given** a failed build, **When** the user views the toolbar/Versions surface, **Then** the failure reason is shown inline (never a silent or generic failure).

### User Story 2 - One merge-free timeline, global or per-session (Priority: P1)

A reviewer gets the **complete picture** by reading a single time-ordered stream — either the whole system or one browser session — with **no manual merging or sorting**. `frontend` / `backend` / `supervisor` is a filterable field on each record, not separate files to stitch together.

**Why this priority**: The user's overriding requirement — logs must be as easy as possible to read as a complete timeline. The value is one correlated, time-ordered view of what the UI, the server, and the kernel did in the same episode.

**Independent Test**: Open BOS, perform an action that spans UI → API → Supervisor, then open the timeline (and the session view) and confirm all three sources appear interleaved in time order in one stream, with no hand-merging of files.

**Acceptance Scenarios**:

1. **Given** records from the frontend, a version server, and the Supervisor for session `S`, **When** they are collected, **Then** each is appended in arrival order to the **global timeline** and to the **session's own file** (`logs/sessions/S.jsonl`), so either is readable as one already-interleaved stream.
2. **Given** a new browser session, **When** BOS loads, **Then** a new session id is generated and is selectable as its own timeline.
3. **Given** a session-less event (Supervisor boot, autonomous process-exit, background job), **When** it is logged, **Then** it appears in the global timeline (no `sessionId`) and is retrievable as such.
4. **Given** the timeline, **When** the reviewer filters by `stream`, `level`, `branch`, or time, **Then** the same underlying records are filtered — one model, many views.

### User Story 3 - The Supervisor's lifecycle is fully logged (Priority: P1)

Every Supervisor state transition is recorded, so "switching back seemed broken" becomes diagnosable.

**Why this priority**: The second half of the motivating report. `begin/build/activate/promote/discard/health`, process spawn/exit, and port handling are currently only `console.log`-ed to an ephemeral, interleaved stdout.

**Independent Test**: Run begin → build → preview → promote (and a discard) and confirm each step, with branch + outcome, is in the supervisor stream.

**Acceptance Scenarios**:

1. **Given** any control action (`begin`, `build`, `activate`, `promote`, `discard`/`stop`, `pin`, `push`), **When** it runs, **Then** start + outcome (success/error, durations, resulting `state`) are logged with `branch` and `versionLabel`.
2. **Given** a promote using safe ordering, **When** each step runs (rebase, off-port build+health-gate, base-port swap, ref fast-forward, tag), **Then** each step and its result is logged, including the restore path on failure.
3. **Given** a version server process exits unexpectedly, **When** the Supervisor observes the exit, **Then** the exit code and the affected role/branch are logged to `logs/system/supervisor.jsonl`.

### User Story 4 - Core backend functions emit logs without rewiring (Priority: P2)

Core `src/lib/**` functions log through one service that automatically attaches the current session and version label, without threading parameters through every signature.

**Why this priority**: "All core system functions emit log messages" must be ergonomic or it won't be adopted consistently.

**Independent Test**: Call a core function inside a request carrying `x-bos-session`; confirm its emitted records carry the right `sessionId` and `versionLabel` with no signature changes.

**Acceptance Scenarios**:

1. **Given** an API request carrying `x-bos-session`, **When** a core function logs via the service, **Then** the record is attributed to that session and to `versionLabel` (`base`|`preview`|`dev`) via request-scoped context.
2. **Given** the app runs under the Supervisor (`BOS_SUPERVISOR_URL` set), **When** the backend logs, **Then** records are shipped to `${BOS_SUPERVISOR_URL}/__supervisor/logs`; **when unset**, they are written to a local `logs/` fallback.

### User Story 5 - Frontend activity and errors reach the server (Priority: P2)

The frontend ships its logs (including uncaught errors) to the Supervisor so client-side failures aren't invisible.

**Independent Test**: Throw an uncaught error in the UI; confirm a `frontend` record for the active session is collected by the Supervisor.

**Acceptance Scenarios**:

1. **Given** the UI calls the logger or throws (`console.error`, `window.onerror`, `unhandledrejection`), **When** it occurs, **Then** a batched record is sent to `POST /__supervisor/logs` for the active session (flushed on interval/size and via `sendBeacon` on `pagehide`).
2. **Given** no Supervisor (plain `npm run dev`), **When** the frontend logs, **Then** it falls back to `POST /api/logs` on the version server.

### User Story 6 - View and query the logs (Priority: P3)

A reviewer can browse sessions and tail the three streams from inside BOS.

**Acceptance Scenarios**:

1. **Given** collected logs, **When** the user opens the Logs surface, **Then** it defaults to the complete timeline and lets them narrow to a session and filter by stream/level/branch/time, served by `GET /__supervisor/logs`.

### User Story 7 - Bounded retention (Priority: P3)

The store does not grow unbounded.

**Acceptance Scenarios**:

1. **Given** logs older than the retention window or exceeding the size cap, **When** the Supervisor prunes, **Then** old timeline days and session files are removed without touching files currently being written.

### Edge Cases

- **Supervisor briefly unreachable** (during a promote/discard server swap): producers buffer a bounded tail and retry; a last-resort local fallback file prevents loss of the records that matter most.
- **Logging must never break the app**: all producer paths are fire-and-forget and MUST NOT throw into core logic or block a request.
- **Large build output**: stored as its own referenced blob file, not inlined into a JSONL line, so single-line appends stay small and uncorrupted.
- **No session id** (server-initiated/background/boot work): recorded in the global timeline only (no `sessionId`).
- **Secrets**: provider keys and other sensitive config MUST NOT be logged.
- **Plain dev mode**: no Supervisor present → local-file sink; `/__supervisor/*` is not reachable.
- **Clock skew** between processes: each record carries the emitter's timestamp; the Supervisor also stamps receipt time.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The **Supervisor MUST be the central log sink** — the always-on trusted kernel is the sole writer of the canonical log store. Producers (frontend, version-server backends) MUST ship records to it; they MUST NOT write the canonical store directly. The only exception is the **no-Supervisor dev fallback** (local file), used when `BOS_SUPERVISOR_URL` is unset and `/__supervisor/*` is unreachable.
- **FR-002**: Session identity MUST be a **browser session id**: generated client-side (`crypto.randomUUID()`), stored in `sessionStorage` (a new browser/window session yields a new id), and propagated as the `x-bos-session` header on `/api/*` and `/__supervisor/*` requests. Every record MUST carry `sessionId` when one is known.
- **FR-003**: Records MUST form a single **time-ordered timeline** that reads as the complete picture **without manual merging**. The Supervisor (single writer) MUST append every record, in arrival order, to a **global timeline** (`logs/timeline-<YYYY-MM-DD>.jsonl`) and, when a session is known, to that **session's own file** (`logs/sessions/<sessionId>.jsonl`) with all sources interleaved. `stream` (`frontend|backend|supervisor`) and `versionLabel` are **record fields used for filtering — never separate files to stitch together**. Session-less events live in the global timeline only (no `sessionId`). The store root MUST live under **canonical data** (`BOS_CANONICAL_DATA`/`data/logs`), shared across versions and surviving a discarded preview clone.
- **FR-004**: Each record MUST be one JSON object per line (JSONL) with at least: `ts`, `level` (`debug|info|warn|error`), `stream` (`frontend|backend|supervisor`), `sessionId?`, `versionLabel` (`base|preview|dev`), `component`, `msg`, optional `data`, `err` (message + stack), and `branch?`.
- **FR-005**: The Supervisor MUST **capture build output**: stream the full stdout+stderr of `npm run build` to a referenced blob file (`logs/builds/<branch>-<ts>.log`), link it from a timeline record, set the preview to `failed` with the captured error tail as the reason on non-zero exit, and return that reason from `POST /__supervisor/build` (and any promote rebuild). The motivating black box MUST be eliminated.
- **FR-006**: The Supervisor MUST log every lifecycle transition — `begin`/provision, `build` (start + result + state), `activate`, `promote` (each safe-ordering step incl. the restore path), `discard`/`stop`, `pin`, `push`, health-gate outcomes, and child process spawn/exit — with `branch`, `versionLabel`, outcome, and (when triggered by a session) `sessionId`.
- **FR-007**: The backend MUST expose a **logging service** used by core `src/lib/**` functions. Request-scoped `sessionId` + `versionLabel` MUST be carried via `AsyncLocalStorage` so functions log without signature changes. A **sink abstraction** MUST have an HTTP implementation (ships to the Supervisor) and a file implementation (dev fallback); selection is driven by `BOS_SUPERVISOR_URL`.
- **FR-008**: The frontend MUST provide a **batched logger** that ships to `POST /__supervisor/logs` (flush on interval + size threshold; `sendBeacon` on `pagehide`) and captures `console.error`, `window.onerror`, and `unhandledrejection`. It MUST fall back to `POST /api/logs` when no Supervisor is present.
- **FR-009**: The Supervisor MUST accept ingestion at `POST /__supervisor/logs` (a batch of records). It MUST validate and **cap** total payload and per-record sizes, stamp a server receipt time, and never trust client-supplied file paths or session ids for anything beyond partitioning.
- **FR-010**: Producers MUST be **fire-and-forget and non-fatal**: a logging failure MUST NOT throw into core logic or block a request. Producers MUST keep a **bounded in-memory buffer with retry** to bridge brief Supervisor-unreachable windows (promote/discard swaps), with a last-resort local fallback so the most relevant records are not lost.
- **FR-011**: The Supervisor MUST serve reads at `GET /__supervisor/logs?session=&stream=&level=&since=`, returning a time-ordered stream. A **Logs** surface in BOS MUST default to the **complete timeline** and let the user narrow by session, stream, level, branch, or time (filters over one model, not separate files). Reads MUST go through the sink (the Supervisor), consistent with it being the single owner of the store.
- **FR-012**: The Supervisor MUST enforce **retention**: the global timeline is **day-rotated** (`timeline-<YYYY-MM-DD>.jsonl`) and pruned together with the per-session files by age and total size (defaults: 7 days / a configurable size cap), without deleting files that are currently being written.
- **FR-013**: Only the Supervisor writes the canonical store (single writer → no cross-process concurrent-append corruption); the global-timeline and per-session writes are both performed by that single writer. Large blobs (build output) MUST be separate referenced files so JSONL line appends remain small and atomic.
- **FR-014**: A `logging` config namespace MUST expose at least: minimum level, retention (days + size cap), and a toggle for frontend capture; surfaced in Settings.
- **FR-015**: Logs MUST NOT contain secrets (provider API keys, auth tokens, full provider config); known sensitive fields MUST be redacted. The store is operational diagnostics stored under gitignored canonical data.

### Key Entities

- **Log Record** — one structured event (the JSONL fields in FR-004).
- **Timeline** — the complete, time-ordered record stream (global, and per-session); the primary, merge-free way to read logs.
- **Log Stream** — a record field (`frontend` / `backend` / `supervisor`) used to filter a timeline, not a separate file.
- **Session** — a browser session id; selects a per-session timeline view.
- **Build Log** — a per-build stdout/stderr blob file referenced from a record.
- **Log Store** — the Supervisor-owned directory tree under canonical data (the sole writer).
- **Log Sink** — the producer-side transport abstraction (HTTP-to-Supervisor | local file).
- **Logging Service** — the backend entry point core functions call; resolves request-scoped context.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a preview build fails, the user can see the real build error in the UI and the complete output in the session's build log — the failure is never a black box.
- **SC-002**: For any given session id, a reviewer can retrieve a single correlated timeline spanning frontend, backend, and supervisor.
- **SC-003**: 100% of Supervisor lifecycle transitions (begin → build → ready/failed, activate, each promote step, discard, process exit) are recorded with branch + outcome.
- **SC-004**: Logging never crashes or blocks BOS; a Supervisor outage loses at most the buffered tail, not application function.
- **SC-005**: Opening a new browser produces a new session id selectable as its own timeline; session-less events still appear in the global timeline.
- **SC-006**: A complete timeline — global or for one session — is readable as a single time-ordered stream with no manual file merging.

## Assumptions

- BOS normally runs under the Supervisor (`run-full.sh` / `run-dev.sh` set `BOS_SUPERVISOR_URL`, inherited by version servers via `startProc`); plain `npm run dev` degrades to a local-file sink.
- A single canonical data dir is shared across versions (`BOS_CANONICAL_DATA`), and the log store lives there.
- Logs are **operational diagnostics**, not a tamper-proof security/audit log (no signing/immutability requirement in v1).
- The session id is best-effort correlation, not an authentication or identity mechanism.
- The Supervisor stays Node-built-ins-only and is not self-modified; its log store + ingestion are self-contained (no `src/` imports).

## Design notes (non-normative)

**Layering (per BOS conventions).**
- **models** — `log_models.ts`: `LogRecord`, `LogLevel`, `LogStream`, `LogQuery`, `LogRecordInput`.
- **interface + impl** — `LogSink` interface with `HttpLogSink` (→ Supervisor) and `FileLogSink` (dev fallback).
- **service** — `LoggingService` (what core functions call); uses `AsyncLocalStorage` for request-scoped `sessionId`/`versionLabel`.
- **presentation** — `POST /api/logs` (dev-mode ingest fallback) and a viewer proxy/`GET`; the Supervisor owns `POST/GET /__supervisor/logs`.
- **supervisor** — self-contained `tools/supervisor/log-store.mjs` (writer + retention) wired into ingestion, `buildAndStart`, and all control transitions.

**Store layout.** `logs/timeline-<YYYY-MM-DD>.jsonl` (global, day-rotated); `logs/sessions/<sessionId>.jsonl` (per-session view, all sources interleaved); `logs/builds/<branch>-<ts>.log` (build blobs, referenced from records). Written only by the Supervisor.

**Transport (verified against current code).**
- Browser → Supervisor: same-origin `POST /__supervisor/logs` (the Supervisor owns the public port and routes `/__supervisor/*` itself; the toolbar already calls it).
- Backend → Supervisor: `POST ${BOS_SUPERVISOR_URL}/__supervisor/logs` (`BOS_SUPERVISOR_URL` is set by the launchers and inherited by version servers).
- Supervisor → disk: direct, single writer.

**Touch-points.**
- `tools/supervisor/supervisor.mjs`: `buildAndStart` (capture output), `handleControl` (ingest + read endpoints, log transitions), `startProc` (log child exits; already passes `BOS_VERSION_LABEL`/`BOS_CANONICAL_DATA`).
- `src/lib/devharness/supervisor.ts`: forward `x-bos-session` on control calls made server-side.
- `src/lib/os-client.ts` and other client fetchers: attach `x-bos-session`.
- `src/lib/config/registry.ts`: add the `logging` namespace + a Logs settings surface.

**Phasing.** P1 Supervisor sink + build capture + transition logging → P2 backend service/sink/ALS → P3 frontend logger + error capture → P4 viewer + retention.

## Notes

- Related specs: `005-self-modification` (Supervisor lifecycle this logs), `006-data-isolation` (canonical data location), `008-self-testing` (build/health stage that fails).
- **Resolved — timeline-first (the priority is easiest reading of a complete timeline):** the global time-ordered timeline is the source of truth and a per-session file is a convenience view; both read as one merge-free stream, and `frontend`/`backend`/`supervisor` are filter fields rather than separate files. This supersedes the earlier per-session three-file layout.
