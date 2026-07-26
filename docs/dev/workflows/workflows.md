# Workflows

Multi‑step automations that orchestrate sub‑agents and tools. Modules:
`src/lib/workflows/`. User‑facing: `docs/usage/apps/workflow-manager.md`.

Surfaced as a [Service Daemon](../apps/services.md) item —
`dataDir()/user-apps/workflows/` (the user's own GitFS repo — BOS doesn't ship
or seed this item; the user places it there themselves) — installed via
Settings → Plugins → Services (or the Marketplace's "My Apps" section), then
reached via the service card's "Open App" button (`GET
/api/services/workflows/app`, same-origin `window.open()`, not a sandboxed
installed app). This item predates the Service Daemons architecture; it was
migrated from a bespoke silently-auto-installed GitFS app
(`ensureWorkflowApp()` — since removed) onto the standard item shape.

---

## Model (`src/lib/workflows/types.ts`)

A `Workflow` = `{ id, name, version, config?, agents[], steps[], ui? }`.

- **`WorkflowStep`** — `type: "delegate" | "tool" | "ag-ui"`, optional `agentId`
  (must exist in `wf.agents`), `toolName` (for `tool` steps — exactly one named
  tool), `input`, `outputConvention`, `dependencies[]`, `retryLimit`, `timeout`.
- **`WorkflowAgentRef`** — a workflow‑local `{ id, type, description? }`; the
  underlying sub‑agent (in `data/agents`) must exist.
- **`WorkflowConfig`** — `maxConcurrentSteps`, `defaultRetryLimit`, `defaultTimeout`.
- **States** — `WorkflowState`: CREATED → VALIDATED → RUNNING →
  COMPLETED/FAILED/CANCELLED (+ RETRYING). Per‑step `StepStatus`:
  queued/running/retrying/complete/failed/cancelled.

---

## Store (`store.ts`)

Persists workflows in the **VFS** under `/Workflows/` (durable, inspectable). CRUD +
load/save. Runtime status is tracked per active run (`WorkflowRuntimeStatus`).

## Validation (`validate.ts`)

`ValidationResult { ok, errors[], warnings[] }`. Checks the step graph is **acyclic**,
every `dependencies` id resolves, every referenced `agentId` exists in `wf.agents`,
and `tool` steps name a tool. Run before execution (state → VALIDATED).

## Runner (`runner.ts`)

Executes the DAG: independent steps run **in parallel** up to `maxConcurrentSteps`;
dependent steps wait. Per‑step **retries** with backoff (`retryLimit`) and soft
`timeout`. Emits `ExecutionEvent`s (`workflow.start/complete/fail/cancel`,
`step.start/complete/fail/retry`, `ag-ui`) — streamed as **NDJSON** so the UI shows
live progress. Supports **cancellation**.

- `delegate` steps → `runSubAgent` ([sub‑agents](../assistant/sub-agents-and-delegation.md)).
- `tool` steps → the agent calls exactly the one named BOS/MCP tool.
- `ag-ui` steps → emit a UI/data payload.

**Execution stays on the main thread — deliberately not a worker_thread.**
`delegate`/`tool` steps call `runSubAgent()`, the full assistant/LLM stack,
which can't reasonably run isolated in a worker (would mean bundling that
entire stack into a standalone script, or a full IPC/RPC bridge back to the
main thread, for no real isolation benefit — see
[Design heuristics](../design-heuristics.md)). The `workflows` service
(`dataDir()/user-apps/workflows/services/index.js`) is a lifecycle-only shell
instead: `isWorkflowsServiceRunning()` checks `serviceRegistry().getService("workflows")?.state === "running"`,
and both `POST /api/workflows/run` and the `workflow_run` assistant tool
refuse (503 / an error string, respectively) unless it's `true`. This is what
gives Settings → Plugins → Services' Start/Stop toggle real meaning here.
`readDefaultMaxConcurrentSteps()` also reads the service's
`dataDir()/config/workflows/workflows.json` (`defaultMaxConcurrentSteps`,
default `5`) as the fallback when a workflow doesn't set its own
`config.maxConcurrentSteps`.

## Generate (`generate.ts`)

Builds a workflow from a natural‑language description via a direct LLM call
(`@/lib/agent/llm`'s `complete()`) — not `runSubAgent()`, so unlike `run` it
is **not** gated on the `workflows` service running; drafting/saving a
workflow definition doesn't need anything installed.

---

## HTTP (`/api/workflows*`)

| Route | Purpose |
|---|---|
| `/api/workflows` | list / get / create / update / delete |
| `/api/workflows/validate` | validate a workflow |
| `/api/workflows/run` | execute (**NDJSON** event stream); 503 if the `workflows` service isn't running |
| `/api/workflows/status` | runtime status of a run |
| `/api/workflows/cancel` | cancel a run |
| `/api/workflows/generate` | generate from a description |

Assistant-facing tools (`src/lib/assistant/tools/server/workflows.ts`):
`workflow_create`, `workflow_modify`, `workflow_run`, `workflow_status`,
`workflow_cancel`, `workflow_export`, `workflow_validate`.

---

## Notes for the developer agent

- Reference agents that actually exist; `validate` will reject dangling `agentId`s.
- Browser‑automation tools become available to `tool` steps when automation is
  enabled ([here](../automation/browser-automation.md)).
- Keep events flowing through the NDJSON stream so the UI stays live; don't batch.
