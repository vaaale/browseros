# Self-Healing Mechanism (031)

BOS notices its own failures, has an agent investigate them **against BOS's own
source**, and — when the finding is a genuine gap — drives the Build Studio
pipeline unattended to a test-driven fix on a preview you review. Promotion is
always yours.

Source: `src/lib/self-heal/` (the spine), `src/plugins/self-heal/` (trigger
capture), `src/lib/assistant/tools/server/self-heal.ts` +
`diagnostics.ts` (agent tools), `src/app/api/self-heal/route.ts` (HTTP),
`src/apps/build-studio/selfheal/` (the review pane),
`src/components/apps/settings/SelfImprovementTab.tsx` (Settings),
`seed/agents/conversation-reviewer/AGENT.md` +
`seed/skills/agent-behavior-review/SKILL.md` (the Diagnostician).

Plus the **platform** layer the observability/control scope-add added, which is
shared by every headless run and not self-heal-specific:
`src/lib/agent/subagents/transcript.ts` (per-run transcripts),
`src/lib/agent/subagents/run-registry.ts` (abort by runId),
`src/app/api/agent-transcripts/route.ts` (the read-only transcript API), and
`src/lib/self-heal/{runs,stuck-detector}.ts` (the self-heal consumer of both).

Spec: `specs/user-specs/self-modification/031-self-healing/` (spec.md,
design.md and its fourteen ADRs are authoritative for requirements and
architecture — this doc is the practical how-to).

---

## 1. Mental model

```
detect → diagnose → classify → (fix or resolve) → notify → human-gated promote
```

Two halves, deliberately separated:

- **The fast spine** — deterministic server code that completes in *minutes*.
  It dedupes, enforces the daily cost cap, creates a Healing Case, runs the
  Diagnostician once, and routes on the verdict. Exactly one step in it is an
  LLM call.
- **The slow path** — the autonomous Build Studio pipeline, which runs for
  *hours* on a feature branch and ends by emitting `fix_ready`.

Two hard boundaries the mechanism never crosses:

- It never promotes. It emits `fix_ready`; you promote (FR-024).
- It never touches the Supervisor or the base version. Every code fix lands on
  a feature-branch preview or as an `app_build` result (FR-023).

### Why the spine is not a workflow

The spec originally called the spine "a workflow". It is not, and cannot be:
the bos-core workflow engine is retired (`architecture-overview.md` §14), and
the 002 Workflow Manager service is an **LLM-agent-node** engine with no
deterministic-code node, no event-triggered runs, no cross-run in-process
mutual-exclusion slot, and no in-run suspend/resume. The spine needs all four.

So it is a **034 core headless handler** (`registerCoreExecutor`) fronting a
server-only case store — machinery BOS already has (design ADR-1). The 002
service is an *integration point* for the workflow-timeout trigger, not the
spine's engine.

---

## 2. The five triggers (FR-002 … FR-006)

| Trigger | Source | Default |
|---|---|---|
| `explicit` | `self_heal_request` tool, or "Report a problem" in Build Studio → Self-Heal | **on** |
| `hard-error` | one non-environmental tool error, via the `bos-self-heal` plugin's `afterToolCall` | off |
| `repeated-failure` | N consecutive same-signature failures of one tool inside a window | off |
| `workflow-timeout` | a `com.bos.self-heal.trigger` event carrying a workflow id | off |
| `log-events` | an error-level log from a BOS-owned component namespace | off |

Each is independently toggleable; `selfHeal.enabled` disables all of them and
the scheduled Diagnostician at once. A fresh install is deliberately
conservative — only the explicit trigger is on.

**The capture point is `afterToolCall`, not `onError`.** The agent loop turns
every tool failure into an in-band `Error: <tool>: …` **result string** and
never lets it throw (`agent-loop.ts`'s `toolError`), so a hook watching for
exceptions would see nothing. `onError` fires only for a model-turn failure.

### The environmental allowlist (`allowlist.ts`, clarification C2)

A failure that is *unconditionally* external never reaches the Diagnostician:
network/socket errors, DNS failures, 401, 429, OOM/SIGKILL, gateway/upstream
timeouts. Zero cases, zero tokens (SC-003).

`permission_denied` is deliberately **not** in that set. Only investigation can
tell "your disk said no" (class `a`) from "BOS dropped the permission" (class
`e`), and that investigation is what the Diagnostician is for.

The BOS-owned log-component list is an **allowlist, not a blocklist** — an
unknown or third-party component is excluded by default, so a noisy MCP server
or marketplace service cannot conscript the self-healer into "fixing" BOS.

---

## 3. Dedupe: deterministic, and *before* diagnosis (FR-019, ADR-7)

`signature.ts` computes the identity with pure code, no LLM, in Phase A — so a
duplicate never spends Diagnostician tokens.

```
dedupeKey = <toolName>:<errorCategory>:<sha256(normalizedMessage)>
```

- `errorCategory` is assigned in priority order: HTTP status → exception
  code/class → message pattern → `unhandled_exception`.
- `normalizedMessage` lowercases, then strips UUIDs, hex ids, ISO/epoch
  timestamps, quoted strings and numerics, and (by default) the user-specific
  leading segment of absolute paths — so the same logical bug at two different
  paths dedupes to one case. That last rule is the one judgment call: too
  aggressive merges distinct bugs, too conservative reports the same one twice.
- The **explicit** trigger gets a relaxed key (`<tool>:explicit:<hash of the
  description>`) and a much shorter window (1h vs 24h), because re-reporting a
  problem yourself is usually deliberate.

A suppressed trigger emits `self_heal.dedupe_suppressed` referencing the
original case. Suppression is logged, never silent.

---

## 4. The Diagnostician (FR-007/FR-008, ADR-2)

It is the **existing `conversation-reviewer` agent**, extended with a second
mode — one agent, one tool set, two entry points, selected by input type:

- **Mode 1** — input is a `conversationId`; output is a behavioral review.
- **Mode 2** — input is a failure signature + a case id; output is a
  diagnostics report and a scope-class verdict.

Both modes write **markdown** to `/Documents/BOS Improvements/` (clarification
Q8; Mode 1's output changed from JSON — nothing reads these programmatically,
and Mode 1's page-count recompute gate is untouched).

The agent was already read-only everywhere except its report and already could
not delegate (no `agent_delegate`/`dev_delegate` in its tools), so the
extension is purely additive: `app_list`, `query_events`, `get_event`, and one
new write, `submit_diagnostics_report`.

### `submit_diagnostics_report` verifies, it doesn't trust

Like `submit_review_report`'s page-count gate, this tool **refuses** — with the
specific reason — unless the case id exists, `scopeClass` and `ownership` are in
range, `proposedSurface` names something concrete, and the narrative contains at
least one source citation. Those fields route a code-changing pipeline; an
almost-right report is rejected rather than coerced.

### Ownership is resolved server-side, not by the agent

`app_list` cannot see an item's provenance, and a headless run cannot execute a
frontend tool at all. So the spine computes the d-vs-d-bis facts from
`listInstalledItems()` (a `data/system/<id>` symlink resolving into
`data/user-apps/items/<id>` means the user owns it), hands them to the agent as
fact, and **re-confirms them before routing** — correcting the agent's call in
either direction (design §5).

---

## 5. The six scope classes

| Class | Meaning | What BOS does |
|---|---|---|
| `a` | environmental / transient | closes `env-only`, changes nothing (FR-009) |
| `b` | a skill or memory mis-teaches a working tool | proposes one skill edit, consent-gated (FR-010) |
| `c` | a workflow definition or its data is wrong | proposes one `/Workflows/*.json` edit, consent-gated (FR-011) |
| `d` | a bug in a marketplace app the user does **not** own | notifies only, never modifies (FR-012) |
| `d-bis` | a bug in an item the user **does** own | fixes it, delivers via `app_build` (FR-013) |
| `e` | a genuine gap in BOS's own source | fixes it on a feature-branch preview (FR-014) |

Classes `b` and `c` are the only fixes applied **in place** — there is no
preview to promote afterwards, which is why `consent.ts` refuses to apply
anything unless the case is in `awaiting-consent` with a stored edit, and why
the consent card renders the literal before/after text. There is no force flag.

---

## 6. The state machine (FR-018, design §3.4)

```
new ──► diagnosing ──► diagnosed ──┬─► env-only                        [terminal]
  │                                ├─► awaiting-consent ─► applied | dismissed
  └─► queued-cost                  ├─► notified                        [terminal]
      (cap exhausted)              └─► queued-slow ─► bs-pipeline ─┬─► preview-ready [terminal]
                                                          │        ├─► failed        [terminal]
                                                          │        ├─► dismissed     [terminal]
                                                          └─► suspended ─► (resume) bs-pipeline
                                                                       └─► abandoned [terminal]
```

`store.ts` is the **single source of truth** for this; 034 events are the
derived audit/notification channel and never hold the state machine (ADR-6).
The ordering rule is **emit-after-commit**, so a reader reacting to an event
always finds the store already consistent.

Layout (runtime, gitignored, created on first write):

```
data/self-heal/index.json        warm index: dedupe map, cost ledger,
                                 in-flight slot, both bounded queues
data/self-heal/cases/<id>.json   the full record + its timeline
```

Every mutation is one serialized read-modify-write with an atomic file write, so
an at-least-once event redelivery or a boot reconcile cannot double-act.

---

## 7. Mutual exclusion, and the two queues (FR-015c, ADR-9)

**One** class-e/d-bis case may be in `bs-pipeline` at a time. The slot is a
single field in the durable index (`inFlightSlowPathCaseId`), so it survives
restarts and is correct across the Supervisor's BASE + PREVIEW processes. It is
released in the *same write* as any terminal status — it cannot leak.

A `suspended` case **keeps** the slot: an unanswered question really does block
the next auto-fix. The suspended-timeout sweep is what releases it.

Two distinct FIFOs, which must not be conflated:

- **cost queue** — cases admitted while the daily cap was spent. Not yet
  diagnosed. Bounded (max 100, 7-day TTL); every eviction emits
  `self_heal.cost_cap_evicted` and leaves the case terminal.
- **slow queue** — cases already diagnosed and escalated, waiting for the slot.
  No TTL: escalated work is never dropped for waiting. Dequeuing is **re-entry**,
  not a new trigger, so it is deliberately not re-deduped or re-capped.

---

## 8. The slow-path handoff — the riskiest seam (FR-015/015a/015b)

### Branch pre-conditioning (ADR-3)

FR-015b says the branch must exist "before the BS agent's first token". What
that actually requires is **two conversation ops, in this order**:

1. `saveConversationMessages(caseConvId, agentId, [brief])` — creates the file;
2. `setConversationActiveFeatureBranch(caseConvId, "bos/self-heal-<caseId>")`.

The git ref is **not** created here. `supervisorBegin` provisions it lazily at
the first `dev_delegate`, and it is idempotent. Pre-conditioning the *field* is
all FR-015b needs: it is what stops the agent from calling
`dev_branch_request`, a frontend elicitation that would block an autonomous run
until it timed out.

`caseId` is one lowercase `[a-z0-9]+` segment (`0001`, `0141`) precisely so
`bos/self-heal-<id>` satisfies `FEATURE_BRANCH_RE`'s four-segment limit. The UI
renders it with an `EHS-` prefix (`EHS-0141`), which is presentation only and
never part of the branch.

### The brief carries what code cannot enforce

`brief.ts` is not boilerplate — it *is* the mechanism for three requirements no
code outside a delegated agent's run can enforce:

- **FR-015** the pre-authorization sentence, verbatim and unbroken (it overrides
  the BS agent's default stop-at-every-step contract *for this conversation
  only*; the agent definition is unchanged globally), plus **commit-before-
  advance**: every confirmed decision is written to its artifact *before* the
  next question, so a cold restart recovers all of them from disk.
- **FR-015a** at `plan` → `tasks`, compare the plan's file list against the
  report's `proposedSurface`; on divergence make **exactly one** re-diagnosis
  call; a second disagreement goes to the user and is never LLM-arbitrated.
- **FR-014** TDD (failing test first), the coverage target, and the plan's file
  list as a **hard** scope constraint that `converge` re-checks.

The report is passed as **user intent**, not as a spec: the `specify` step must
produce a real `spec.md` from it (clarification C3).

### Suspend and resume (FR-016, C5)

`self_heal_request_decision` parks the case, emits `decision_needed`, and the
run **ends** (terminate-and-retrigger; there is no HITL node in v1). The user
answers on the BS page → `decision_resolved` → the spine re-enters the **same**
conversation with the answer, and the agent recovers its confirmed decisions
from the artifacts on disk.

### Completion (FR-017, ADR-8)

The BS agent calls `self_heal_complete_fix` at the end of `implement`. The
spine then **verifies the preview's real build state with the Supervisor** —
the agent reports that tests passed (only it knows that), BOS checks that the
build is real. A known state that isn't `ready` fails the case rather than
notifying.

Option B is kept as a *reconcile fallback*: a run killed after a healthy build
but before it called the tool is recovered at boot.

---

## 9. Cost: real tokens, not estimates (FR-020, ADR-5)

Before this feature BOS did not know what its own agent runs cost —
`TurnResult` and `AgentRunResult` had no usage field and `anthropicTurn` never
read `message_delta`. Enforcing a token cap honestly needed that fixed, so
usage now propagates **turn → loop → run**:

- `model-turn.ts` reads Anthropic's `message_start`/`message_delta`, OpenAI's
  final chunk (`stream_options: {include_usage: true}`, sent only for the
  `openai` provider — some compatible servers reject unknown fields), and the
  Responses API's terminal response;
- `agent-loop.ts` sums it across every turn onto `AgentLoopResult.usage`,
  including on cancelled and errored exits — a run that partly happened still
  cost what it cost;
- `claude-runner.ts` parses the Claude Code stream-json `result` line and
  OpenCode's step events.

**`undefined` means unknown and must never become a fabricated zero** — a run
that looks free is a run that never counts against the cap. When a provider
reports nothing, `cost.ts` falls back to a coarse estimate and marks the ledger
entry `estimated: true`.

The cap resets at **midnight UTC** and is enforced **between** cases, not
within one: a case already running finishes and is billed at its end, so one
very large case can overshoot. That is FR-020's stated semantics, not an
oversight.

---

## 10. Re-entrancy (FR-025, ADR-4)

FR-025 holds **by construction** on the dominant path: `runLocalHeadless` calls
`runAgentLoop` *without* a `hooks` argument (`composePluginHooks` is wired only
into `start-run.ts`, the main chat run), so a failing Diagnostician — or a tool
error inside the BS pipeline it spawned — cannot reach the trigger hook at all.

Two backstops cover the rest:

- **(a) a conversation marker.** Every spine-seeded conversation carries
  `selfHeal: {role, caseId}`. The hook — whose context is only
  `{runId, conversationId, agentId}` — checks that and skips. This covers the
  one path where a self-heal-tainted run *does* fire hooks: a self-heal
  conversation later driven from the chat UI.
- **(b) an event-payload filter** in the deterministic front door: any event
  whose payload carries `selfHeal.role` is never intake'd. Hook-independent, so
  it holds regardless of which run path emitted the event.

---

## 11. Boot reconcile (design R9)

A process that dies mid-pipeline leaves a case in `bs-pipeline` holding the
slot. On boot the spine re-derives the truth from the Supervisor: `ready` with
no `fix_ready` yet ⇒ `preview-ready`; `failed` ⇒ `failed`; still building ⇒
left alone; no preview at all ⇒ `failed` (no auto-retry). It also sweeps
suspended timeouts and starts the queue.

It **must** run single-owner — every server process runs `instrumentation.ts`,
and the Supervisor keeps BASE plus (while previewing) PREVIEW alive, so two
processes would both emit `fix_ready`. It competes for the scheduler's
container-wide daemon lock (`self-heal-reconcile`) rather than inventing a
second election.

---

## 11a. Headless-run transcription (FR-029/FR-030/FR-031, ADR-10)

Every **headless** run — one BOS starts for itself, with no browser attached —
writes one markdown file:

```
data/agent-transcripts/<agentId>/<runId>.md
```

`src/lib/agent/subagents/transcript.ts` owns it. It is a **platform** capability,
not a self-heal one: the writer is a side-channel observer on the event stream
the two headless entry points already process, so the scheduler, the Telegram
router, workflow steps, `/api/subagents/delegate` and self-heal all get
transcripts without knowing the module exists. A live *chat* run is not a
headless run and gets no transcript — it is already in Chats.

**Format.** YAML frontmatter (`agentId`, `agentName`, `runId`, `startedAt`,
`kind` = `local`|`claude`, `parentRunId?`, `caseId?`) then `## Task` and
`## Timeline`, one line per event with a run-relative `[mm:ss.d]` stamp:

```
- [00:00.9] `file_search`({"dir":"src/components","query":"file_read"})
- [00:01.6]   ↳ file_search → ok: 12 matches — FilesTool.tsx:44 · …
- [00:02.1] **assistant** Let me read the file-tools module…
```

`endedAt` and `aborted` are **omitted while the run is in flight** — that
absence is the whole of "viewable up to the present" (FR-031): a reader sees a
growing timeline with no end marker, and `readTranscript` derives the status
from it (no `endedAt` ⇒ in-flight, `aborted: true` ⇒ aborted, else completed).
On finish the writer appends the end line and stamps the frontmatter.

Three properties matter, because `runLocalHeadless` is a **shared** path:

- **Config-gated** — `agentRuns.transcriptions.enabled` (its own platform
  namespace, default true, surfaced in Settings → Self Improvement). Off ⇒
  `open()` marks the writer disabled and every method is a no-op.
- **Never throws** — the first I/O failure disables that writer and logs once. A
  transcript is an artifact, never part of a run's contract.
- **Per-turn cadence** — one append per assistant message / tool call / result.
  Reasoning deltas are buffered and flushed at the turn boundary, never written
  per token.

**Not the VFS.** `data/agent-transcripts/` is a *sibling* of the VFS, like
`data/self-heal/`, so a transcript can never appear in the Chats app, the
Diagnostician's idle-conversation review, or memory curation (FR-030). The only
reader is `GET /api/agent-transcripts` — **GET only**, no write surface:

- `?runId=` → `{ ok, found, agentId, runId, status, markdown, caseId? }`
- `?agentId=` → that agent's runs, newest first
- `?caseId=` → the case's `runs[]`, read from the **case record** (authoritative
  for case-scoped listing; the file's `caseId` frontmatter is for a human who
  opens the file)

The `caseId` line is stamped by the owning *consumer*: on `run_started` the
spine calls `markTranscriptCaseId(runId, caseId)`. The platform writer never
learns what a case is.

Wiring, per runner:

| | `runLocalHeadless` (`runner.ts`) | `runClaudeAgent` (`claude-runner.ts`) |
|---|---|---|
| runId | `opts.runId` else `headless-<agentId>-<ts>` | generated at the TOP, before every refusal return |
| fed from | the existing `emit` handler | the existing stdout `tool_use` parsing + the final result |
| `endedReason` | the loop's own reason (`completed`/`cancelled`/`error`/`max_steps`) | `completed`/`error` — no step loop, so never `max_steps` |

---

## 11b. Platform abort (FR-032, ADR-11)

`abortHeadlessRun(runId)` in `src/lib/agent/subagents/run-registry.ts`
terminates an in-flight headless run. It is a **server-side platform export,
not an agent-callable tool** — the spine and the self-heal route import it;
there is no "kill any run" tool or endpoint.

Abort was always first-class *inside* a run (the loop checks its AbortSignal at
every step boundary — the chat's Stop uses exactly that); what was missing was
the **handle**. `runLocalHeadless` built a throwaway `new AbortController()`,
and a CLI run's `child` was a local reference. Now both register on start
(`registerRun`) and clear on end (the local `finally`, the CLI's `close`).

**The cascade is the load-bearing part.** A pipeline case's in-flight run is the
`build-studio` run (`type: local`), but the coding is done by a **nested
Developer run** (`type: claude`) that build-studio starts via `dev_delegate` —
a separate top-level run with its own runId and its own spawned CLI child. The
local runner does **not** forward `tool_progress` to `opts.onEvent`, so that
nested run never appears in the parent's event stream: aborting only the parent
would unwind the build-studio loop while the Developer CLI kept editing the
worktree. So `delegate-common.ts` passes `parentRunId: ctx.runId` on the claude
path, and aborting **any** member of a family aborts the whole family.

- CLI children get `SIGTERM`, then `SIGKILL` after 5s — a harness wedged in a
  long tool call can outlive a `SIGTERM`, and a Stop that leaves the process
  editing the worktree would be a lie. (The pre-existing *timeout* path keeps
  its bare `SIGTERM`; only the abort path escalates.)
- The kill goes through the run's **own** signal/child, so its normal end path
  runs: the partial transcript and its `aborted: true` mark are written by the
  same code a clean completion uses. There is no abort-only writer.
- The registry is a `globalThis` singleton (HMR-safe) and single-process by
  design — a headless run lives in exactly one process. The durable record of a
  stop is the transcript's `aborted` mark plus the case's `stopped` state.
- `abortHeadlessRun` returns **false** for an unknown runId. A caller reports
  that truthfully rather than claiming a kill.

---

## 11c. Stuck-run detection, and Stop / Start (FR-033/FR-034/FR-035, ADR-12/13)

### How the spine sees a run at all

Both runs the spine launches go through `runSubAgent`, which already forwarded
every `tool_call`/`tool_result`/`reasoning_delta`/`final_text` to an `onEvent`
callback — neither seam passed one. They do now, and both runners emit
`{ type: "run_started", runId, agentId, startedAt, parentRunId? }` as the
**first** event of a run. That is how a case learns its runId **while the run is
in flight**: the pipeline run is fire-and-forget, so waiting for the returned
result would be far too late for Stop.

`src/lib/self-heal/runs.ts` (`createRunObserver`) is what goes in that seam. Per
run it records the run on the case (`case.runs[]`), stamps the transcript's
`caseId`, feeds tool calls to the detector, and classifies the ending.

The **nested Developer** run is a separate run with its own transcript and its
own registry entry; its internal loop does not reach the build-studio run's
`onEvent`, so the *automatic* detector does not watch it (FR-033 names the
Diagnostician and the pipeline run). A stuck Developer is still covered by the
human surface: its transcript is viewable, and Stop **cascades** to it.

### The detector (`stuck-detector.ts`) — deterministic, no model call

Two conditions:

1. the same `(tool, normalizedInput)` issued `selfHeal.stuckDetector.repeatCalls`
   times (default 5) with **no intervening distinct call and no progress**, or
2. the run ended on **max-steps** (FR-033(b)).

Input normalization reuses FR-019's `normalizeErrorMessage` — but applied
**per value**, walked into nested objects, not to the whole JSON string. That
distinction is not cosmetic: the FR-019 rules replace any *quoted* string with a
placeholder, so normalizing `{"path":"a.ts"}` whole would collapse every
one-string-field object to the same key, and five reads of five different files
— the most ordinary thing a working agent does — would look like a loop.

Gated by `selfHeal.stuckDetector.enabled` (default true). Off ⇒ no `run_stuck`,
no amber indicator, and a max-steps run takes the old `failed` path. Stop still
works; it is a separate control.

**FR-035 holds by construction**: the detector never calls `selfHealIntake` and
never emits a trigger. On fire it records `case.stuckSignature`, emits
`self_heal.run_stuck` (a lifecycle event carrying `selfHeal.role`, which the
intake filter would drop anyway) and updates the UI. A stuck run does **not**
open a new case; the only remedy is Stop/Start or dismissing the case.

### `endedReason` — the M1 fix that makes (2) reachable

The agent loop has always returned `reason: "max_steps"`, but `runLocalHeadless`
special-cased only `"error"` and collapsed `completed`/`cancelled`/`max_steps`
into one indistinguishable clean return. The run-end handler reads
`PipelineRunOutput`, so a run that burned its whole step budget looked exactly
like a run that finished and simply never reported a fix — and was recorded
`failed`: terminal, unrecoverable, and silent about why. So:

`runLocalHeadless` now sets `AgentRunResult.endedReason` on **both** returns
(the loop's reason on the clean one, `"error"` in the error one) plus
`aborted`, and it is threaded through `PipelineRunOutput` (intake) and the
Diagnostician's run-end path. `runClaudeAgent` reports `completed`/`error` —
the CLI is one spawned process, not a max-steps-bounded loop.

### `stopped` — a non-terminal, recoverable pause (FR-018)

```
diagnosing ──Stop──► stopped ──Start──► diagnosing
bs-pipeline ─Stop──► stopped ──Start──► bs-pipeline (or queued-slow)
```

- **Reachable from** the two states with a live run. `suspended` is not a Stop
  source (its run has already ended); nor is a queued case.
- **`stoppedFrom`** records where it came from, so Start restores *that* state
  and relaunches *that* role. Also entered by the run-end handler for a
  max-steps run — same state, same Start.
- **Stop** (`stopRun`): record the case first (`stopped` + `stoppedFrom`, run
  entry → `aborted`), *then* `abortHeadlessRun`. That order is deliberate:
  killing a run makes its own promise settle immediately, and the run-end
  handler would otherwise race in and write `failed` over the user's Stop.
  Then **free the slow-path slot** and start the next queued escalation.
- **Freeing the slot** is the documented choice (ADR-13): a stopped run consumes
  nothing, and holding the single slot for as long as the user leaves it stopped
  would block *every* other fix. `suspended` is deliberately the opposite — it
  holds the slot, released only by the suspended-timeout sweep.
- **Start** (`startRun`): requires `stopped`; relaunches the role **fresh**
  (never a resume of the killed run) with `buildRestartBrief`, which points at
  the last committed artifact and — when there is a stuck signature — names the
  call not to repeat. Because the pipeline commits before it advances (FR-015),
  nothing confirmed before the Stop is lost. Start **re-claims** the slot, or
  goes to `queued-slow` if another case holds it: it re-enters mutual exclusion
  like any escalation rather than bypassing it.
- Both are **idempotent no-ops that report the truth** (R14): a Stop with no
  live run returns `changed: false` with the current status rather than
  erroring, and so does a Start on a case that is not stopped.
- **Boot reconcile leaves a `stopped` case alone** — it is a user's paused
  state, with nothing to recover.
- An **aborted run's partial build is never a fix** (R-SA5): the Developer's
  close handler still stages its half-written work, and the Supervisor may build
  that partial candidate, but readiness is re-derived from the Supervisor, so
  `previewStateFor(branch) !== "ready"` and `completeFix` refuses. That is what
  stops an aborted → `stopped` case from emitting a false `fix_ready`.

- **Discard** (`discardCase`, FR-036): the one *destructive* control — kills
  any in-flight run first (so a discarded case cannot leave an orphaned run
  burning the budget), then `store.deleteCase` removes the record file **and**
  every index trace in one critical section (case entry, dedupe entries — a
  discarded case must not keep suppressing the failure it was opened for —
  queue entries, and the slot if held), then emits
  `com.bos.self-heal.case_discarded` carrying the status/trigger the case died
  with (the record can no longer be read). Transcripts are **not** deleted —
  they are platform artifacts owned by the run layer. A discard of the slot
  holder dequeues the next escalation, same as Stop. Missing case ⇒ no-op
  (`discarded: false`), nothing emitted.

HTTP: `POST /api/self-heal?op=stop`, `?op=start` and `?op=discard`, body
`{caseId}` only — the run acted on is the one the *case* says is in flight,
never a runId the caller names.

---

## 12. Surfaces

- **Build Studio → Self-Heal** (`src/apps/build-studio/selfheal/`) — a
  navigation peer of the conflict pane. Case list (Status → Case → Trigger →
  Scope Class), detail view with the report and the state-transition timeline,
  and a scope-class-dependent action area. Which card appears is keyed off the
  case's **state**, not its class alone: a suspended class-e case needs the
  question, not the build status. Plus, from the scope-add: a per-row **Run
  column** in the case list (`RunActions.tsx` — the stuck `⚠` indicator, Stop
  or Start, and a confirm-guarded `✕` Discard on every row; the controls live
  in the *list* because triage happens while scanning the table, not after
  opening a case) and **Transcripts**
  (`TranscriptsSection.tsx`, below the detail view's timeline — the evidence
  for what the run has been doing). Stop is **amber, not red**: it is
  recoverable via Start, and red is reserved for terminal/failed — which is why
  Discard, the one irreversible control, is the muted red one. `stopped` gets a
  muted tan chip in the list, distinct from amber `suspended` and red
  `failed`. The repeated-call
  highlight in the transcript panel is computed by the *renderer* from the
  case's stuck signature — the transcript file itself knows nothing about the
  detector.
- **Settings → Self Improvement** — the `selfHeal` namespace. Stored **flat**
  (`triggers.hardError`, …) because `/api/config`'s PATCH coerces against a flat
  `fields` list and silently drops anything undeclared; `config.ts` is the only
  place that maps between that storage and the nested config. The scope-add adds
  a *Stuck-run detection* group: `stuckDetector.enabled`,
  `stuckDetector.repeatCalls` (clamped 3–50), and — surfaced here for
  convenience but owned by the platform's own `agentRuns` namespace —
  `transcriptions.enabled`, which governs **all** headless runs.
- **Events** — `com.bos.self-heal.*`. Build Studio declares UI handlers for
  `fix_ready`, `decision_needed`, and (scope-add) `run_stuck` / `run_aborted` /
  `run_restarted` / `case_discarded`, so clicking any of them in the Event
  Viewer opens the pane on that case (for `case_discarded`, on the list — the
  record is gone). The pane also subscribes to those four directly and re-reads
  the list, so a Stop or Discard the user just pressed does not have to wait
  out the 3s poll.
- **Agent tools** — `self_heal_request`, `self_heal_request_decision`,
  `self_heal_complete_fix`, `self_heal_status`, `submit_diagnostics_report`.
  (The spec writes these dotted, e.g. `self_heal.request`; tool *names* cannot
  contain a dot — every provider constrains them to `[a-zA-Z0-9_-]` — so the
  ids are underscored. Event *types* do use dots.)

---

## 13. Testing

- `tests/self-heal/*.test.ts` — the deterministic spine, end to end. The two
  LLM launches are replaced through `_setSpineAgentHooksForTests` (intake) and
  `_setDiagnosticianRunnersForTests` / `_setAgentLayerForTests`
  (diagnostician), so the guards, dedupe, cap, routing, single slot and
  suspend/resume handoff are all testable without a provider.
- `tests/agent/transcript.test.ts` + `tests/agent/run-registry.test.ts` — the
  two platform modules, directly (feed the writer events and assert the file;
  register mock handles and assert the cascade).
- `tests/agent/headless-run-wiring.test.ts` — the join, through the REAL
  `runLocalHeadless`: a scripted-turn run announces itself with `run_started`,
  writes its own transcript from its own event stream, is abortable by runId
  (partial transcript, `aborted: true`, `endedReason: "cancelled"`), and writes
  nothing at all with transcription off. The model seam is the scripted-turn
  provider, so it reaches no provider.
- `tests/self-heal/stuck-detector.test.ts` — pure and deterministic, so it needs
  no model stub at all. It pins the must-NOT-fire cases as hard as the firing
  ones: a false "stuck" would train the user to ignore the indicator.
- `tests/self-heal/stopped-state.test.ts` — Stop/Start, the max-steps branch, the
  run observer, and the FR-035 "no new case" invariant.
- `tests/self-heal/integration-partial-build.test.ts` — R-SA5: an aborted run's
  partial build is not `ready`, so no false `fix_ready`.
- `e2e/031-self-healing.spec.ts` — the browser-level acceptance suite.
- Coverage gate: **≥95% line and branch on `src/lib/self-heal/**` plus
  `transcript.ts` and `run-registry.ts`** (all three are in
  `.c8rc.self-heal.json`'s include list):
  `npx c8 -c .c8rc.self-heal.json npm run test:unit -- tests/self-heal/ tests/agent/transcript.test.ts tests/agent/run-registry.test.ts`

`tests/self-heal/_test-env.ts` overrides **both** `BOS_DATA_DIR` and
`BOS_CANONICAL_DATA`. A few VFS subtrees are rooted in canonical data so they
survive a discarded preview clone (`CANONICAL_SUBPATHS` in `src/os/vfs.ts`), and
`/Documents/Chats` is one of them — a test overriding only `BOS_DATA_DIR` would
silently read and *write* the real conversation store while looking isolated.
Its `cleanup()` is async and drains in-flight store writes first, because the
spine's fire-and-forget launches outlive the test that started them.

---

## 14. Known dependency: the workflow-timeout trigger (design R7)

FR-004 needs the 002 Workflow Manager service to **emit** a timeout event the
spine subscribes to. It does not yet. The spine's handler reads only the three
fields FR-004 names (workflow id, node, configured-vs-actual duration) and is
tolerant of an unknown body, so the trigger works the moment 002 starts
emitting; until then it simply has no source (and is off by default).

Emitting that event is a **002-side addition**, tracked as a cross-spec
dependency, out of scope for this bos-core change.
