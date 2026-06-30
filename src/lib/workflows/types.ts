// Workflow Manager — framework-free types shared by server (runner/store/validate)
// and client (iframe app, WorkflowActions). Safe to import from both.

export type WorkflowStepType = "delegate" | "tool" | "ag-ui";

export type WorkflowState =
  | "CREATED"
  | "VALIDATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "RETRYING";

export type StepStatus =
  | "queued"
  | "running"
  | "retrying"
  | "complete"
  | "failed"
  | "cancelled";

export interface WorkflowAgentRef {
  /** Agent id used by step.agentId; the actual sub-agent (in data/agents) must exist. */
  id: string;
  /** Mirrors the underlying sub-agent's type so the editor can sanity-check picks. */
  type: "claude" | "local";
  description?: string;
}

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  /** For delegate/tool steps, the workflow-local agent id (must exist in wf.agents). */
  agentId?: string;
  /** For tool steps, the name of the BOS/MCP tool the agent should call. */
  toolName?: string;
  /** Arbitrary input passed to the step's runner. */
  input?: unknown;
  /** Human-readable convention telling the agent where to put outputs (e.g. a VFS path). */
  outputConvention?: string;
  /** Step ids this step depends on. Empty = ready immediately. */
  dependencies?: string[];
  /** Max retry attempts for transient failures. Falls back to workflow default. */
  retryLimit?: number;
  /** Soft per-step timeout in seconds. */
  timeout?: number;
}

export interface WorkflowConfig {
  maxConcurrentSteps?: number;
  defaultRetryLimit?: number;
  defaultTimeout?: number;
  /** Conversation ID for dev (claude) delegations: anchors repeated development to
   *  one feature branch (live version control). Defaults to `workflow:<id>` so each
   *  workflow keeps its own branch across runs; a run may override it (e.g.
   *  `gitlab-issue:1234`). */
  conversationId?: string;
}

export interface WorkflowUiSpec {
  type?: "ag-ui";
  spec?: "dynamic" | "static";
  description?: string;
}

export interface Workflow {
  id: string;
  name: string;
  version: number;
  config?: WorkflowConfig;
  agents: WorkflowAgentRef[];
  steps: WorkflowStep[];
  ui?: WorkflowUiSpec;
  createdAt?: number;
  updatedAt?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export type ExecutionEventType =
  | "workflow.start"
  | "workflow.complete"
  | "workflow.fail"
  | "workflow.cancel"
  | "step.start"
  | "step.complete"
  | "step.fail"
  | "step.retry"
  | "ag-ui";

export interface ExecutionEvent {
  type: ExecutionEventType;
  workflowId: string;
  stepId?: string;
  /** Wall-clock timestamp (ms) of when the event was emitted. */
  ts: number;
  /** Attempt index for step.* events (1-based). */
  attempt?: number;
  /** Error message on step.fail/step.retry/workflow.fail. */
  error?: string;
  /** Step output (for step.complete) or arbitrary ag-ui payload. */
  payload?: unknown;
}

export interface StepRuntimeState {
  status: StepStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  lastError?: string;
  output?: unknown;
}

export interface WorkflowRuntimeStatus {
  workflowId: string;
  state: WorkflowState;
  startedAt?: number;
  endedAt?: number;
  steps: Record<string, StepRuntimeState>;
}
