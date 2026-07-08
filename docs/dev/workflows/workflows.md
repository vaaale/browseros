# Workflows

Multi‑step automations that orchestrate sub‑agents and tools. Modules:
`src/lib/workflows/`. User‑facing: `docs/usage/apps/workflow-manager.md`. Surfaced
by the **Workflow Manager** installed app.

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

## Generate / install (`generate.ts`, `install.ts`, `template.ts`)

`generate.ts` builds a workflow from a natural‑language description (LLM). `template.ts`
provides scaffolding; `install.ts` installs the **Workflow Manager** app content.

---

## HTTP (`/api/workflows*`)

| Route | Purpose |
|---|---|
| `/api/workflows` | list / get / create / update / delete |
| `/api/workflows/validate` | validate a workflow |
| `/api/workflows/run` | execute (**NDJSON** event stream) |
| `/api/workflows/status` | runtime status of a run |
| `/api/workflows/cancel` | cancel a run |
| `/api/workflows/generate` | generate from a description |

Client actions (`WorkflowActions.tsx`): `createWorkflow`, `modifyWorkflow`,
`runWorkflow`, `getStatus`, `cancelWorkflow`, `exportWorkflow`, `validateWorkflow`.

---

## Notes for the developer agent

- Reference agents that actually exist; `validate` will reject dangling `agentId`s.
- Browser‑automation tools become available to `tool` steps when automation is
  enabled ([here](../automation/browser-automation.md)).
- Keep events flowing through the NDJSON stream so the UI stays live; don't batch.
