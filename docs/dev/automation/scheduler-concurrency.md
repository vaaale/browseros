# Scheduler concurrency — one daemon, one dispatch per job

How the Unified Job Engine (`src/lib/scheduler/`) guarantees that a due job runs
**once**, even though BOS runs several Node server processes over one data root.

## The bug this exists to prevent (042-scheduler-daemon-lock)

`register()` in `src/instrumentation.ts` runs once **per server process**, and it
starts the scheduler daemon. The Supervisor keeps at least two such processes
alive — a BASE plus, while a feature branch is previewed, a PREVIEW — and
`next dev` adds more. Every one of them used to tick the same jobs on the same
~60s cadence.

The engine's two pre-existing guards are both *per-process* and so did nothing
about it:

- `runningJobIds` is a module-level `Set`. Process A marking a job running is
  invisible to process B.
- The daemon singleton lives on `globalThis`, which is per-process too. It stops
  a double-start *within* a process (Turbopack's separate module graphs) and
  nothing more.

Consequence: a single due job dispatched N times, where N was the number of live
server processes. Idempotent jobs (e.g. "Mark & Watch") absorbed it silently;
a non-idempotent one ("Daily Review") launched N concurrent agent runs — 3–5×
runtime and ~1M-token context errors.

## The fix: two layers

### Layer 1 — daemon owner election

`startDaemon()` no longer starts ticking. It competes for a single
container-wide lock and only the winner runs the tick loop:

| Concern | Behaviour |
|---|---|
| Lock file | `<canonical data>/scheduler/daemon.lock` |
| Winner | Ticks, and refreshes the lock's heartbeat on a timer |
| Losers | Keep re-running the election every `electionMs` (30s default) |
| Crashed owner | Reclaimed by the next election — immediately if its PID is gone, otherwise once its heartbeat ages out (90s default) |
| `stopDaemon()` | Releases the lock synchronously, so a successor takes over at once |

The election is inside the engine, not open-coded in `instrumentation.ts`, so
every entry point (routes, tests, the `daemon.ts` façade) gets the same
guarantee.

### Layer 2 — atomic per-job dispatch locks

Every dispatch (`tick()` **and** `runJobNow()`) first takes
`<canonical data>/scheduler/job-locks/<jobId>.lock`, holds it with a heartbeat
for the whole run, and releases it in a `finally`. So even if two daemons
somehow coexist — a promote/restart overlap, a suspended process that has not
yet noticed it lost the daemon lock — the job still runs once. `runningJobIds`
remains as a free in-process fast path, but the **disk lock is the authority**.

## Why the locks live in `BOS_CANONICAL_DATA`

`src/lib/scheduler/lock.ts` roots itself at
`(BOS_CANONICAL_DATA ?? dataDir())/scheduler`. This matters: a preview runs with
its **own** `BOS_DATA_DIR` (a throwaway hardlink clone of the data dir —
`tools/supervisor/lib/proc.mjs`) while sharing one `BOS_CANONICAL_DATA` with
base. A `BOS_DATA_DIR`-rooted lock would therefore not dedup base against
preview at all — and those two carry copies of the same job ids, which is the
exact production case. Canonical rooting is the same convention `os/vfs.ts`
uses for `Documents/Chats`, and it sidesteps hardlink-clone aliasing. Outside
the Supervisor, `BOS_CANONICAL_DATA` is unset and the path is simply
`dataDir()/scheduler` — one lock scope per user container.

## Lock mechanics (`src/lib/scheduler/lock.ts`)

- **Acquire = one atomic step.** A record is written to a staging file, then
  `fs.link(staged, lockFile)` publishes it. `link(2)` fails with `EEXIST` if the
  lock exists, atomically — there is no read-then-write gap for a second process
  to slip through, and the lock file is never observable half-written.
- **PID liveness.** `process.kill(pid, 0)` sends no signal: `ESRCH` means dead,
  `EPERM` means alive-but-not-ours (treated as **held** — never steal), anything
  else is treated as alive. A dead PID is only trusted when the record's
  `host` matches `os.hostname()`; a foreign host's PID number means nothing
  locally, so only the heartbeat can expire it.
- **Stale reclaim.** A reclaimer verifies the inode has not changed and then
  `rename`s the stale file away. Rename of the source is itself atomic, so
  exactly one of several reclaimers wins and the losers re-compete rather than
  deleting whatever replaced it. A malformed/truncated record counts as stale.
- **Holders self-validate.** `refreshLock()` returns `false` if the record's
  token is no longer ours. A holder that is reclaimed (e.g. suspended past the
  staleness window) learns about it on its next heartbeat and stands down
  instead of ticking alongside the new owner.

## Reading daemon status

`getDaemonStatus()` is this process's local view (`owner: true` only in the
elected process). API routes use **`readDaemonStatus()`**, which falls back to
the lock record so a request served by a non-owner process still reports the
container-wide owner — otherwise the Scheduler app would flip to "Daemon idle"
depending on which process answered.

## Tests

`tests/scheduler/` — run with `npm run test:unit`:

| File | What it proves |
|---|---|
| `multi-process-dispatch.test.ts` | Spawns real Node processes (bundled with esbuild via `_bundle.ts`) against one data dir: 5 processes ticking one due job dispatch it **once**; same for `runJobNow`; one owner is elected and a `SIGKILL`ed owner is taken over. All three fail on the pre-fix engine (5 dispatches, no lock). |
| `daemon-lock.test.ts` | The lock primitive: atomic acquisition, refusal while held, reclaim on dead PID / aged heartbeat / garbage record, `EPERM` handling, never releasing someone else's lock. |
| `single-process.test.ts` | No regression for a lone process: it elects itself, fires the due job once, `nextRunAt` math is unchanged, locks are released. |
