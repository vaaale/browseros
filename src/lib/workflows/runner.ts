import "server-only";
import { runSubAgent } from "@/lib/agent/subagents/runner";
import { getAgent } from "@/lib/agent/subagents/store";
import type { Agent } from "@/lib/agent/subagents/types";
import {
  appendExecutionLog,
  clearExecutionLog,
  setRuntimeStatus,
  updateStepRuntime,
  updateWorkflowState,
} from "./store";
import type {
  ExecutionEvent,
  ExecutionEventType,
  StepRuntimeState,
  Workflow,
  WorkflowRuntimeStatus,
  WorkflowStep,
} from "./types";

// Per-workflow abort controllers so the cancel route can stop in-flight runs.
const RUNNING = new Map<string, AbortController>();

export function cancelWorkflow(id: string): boolean {
  const ctl = RUNNING.get(id);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

export function isRunning(id: string): boolean {
  return RUNNING.has(id);
}

interface RunContext {
  workflow: Workflow;
  abortSignal: AbortSignal;
  outputs: Map<string, unknown>;
}

interface StepResult {
  status: "complete" | "failed" | "cancelled";
  attempts: number;
  output?: unknown;
  error?: string;
}

function makeEvent(
  workflowId: string,
  type: ExecutionEventType,
  patch: Partial<ExecutionEvent> = {},
): ExecutionEvent {
  return { type, workflowId, ts: Date.now(), ...patch };
}

async function resolveSubAgent(agentId: string): Promise<Agent | undefined> {
  return getAgent(agentId);
}

function isTransientError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? "";
  return (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed")
  );
}

function backoffMs(attempt: number): number {
  // Exponential backoff capped at 8s: 500, 1000, 2000, 4000, 8000…
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt - 1));
}

async function withTimeout<T>(p: Promise<T>, timeoutSec: number | undefined, signal: AbortSignal): Promise<T> {
  if (!timeoutSec) {
    if (signal.aborted) throw new Error("aborted");
    return p;
  }
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`step timed out after ${timeoutSec}s`)), timeoutSec * 1000);
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { clearTimeout(t); signal.removeEventListener("abort", onAbort); resolve(v); })
     .catch((e) => { clearTimeout(t); signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

async function runDelegateStep(step: WorkflowStep, ctx: RunContext): Promise<unknown> {
  const agent = step.agentId ? await resolveSubAgent(step.agentId) : undefined;
  if (!agent) throw new Error(`Sub-agent "${step.agentId}" not found`);
  const task = buildDelegateTask(step, ctx);
  const result = await runSubAgent(agent, task);
  if (result.error) throw new Error(result.error);
  return result.output;
}

async function runToolStep(step: WorkflowStep, ctx: RunContext): Promise<unknown> {
  // Tool steps become a tightly-scoped delegation: instruct the agent to call
  // ONLY the specified tool and write its result per outputConvention.
  const agent = step.agentId ? await resolveSubAgent(step.agentId) : undefined;
  if (!agent) throw new Error(`Sub-agent "${step.agentId}" not found`);

  const inputJson = step.input == null ? "(none)" : JSON.stringify(step.input);
  const promptParts = [
    `You are executing a single workflow step.`,
    `Call ONLY the tool named "${step.toolName}". Do not call any other tool.`,
    `Tool input: ${inputJson}`,
    step.outputConvention ? `Output convention: ${step.outputConvention}` : "",
    `When the tool returns, briefly summarize its result in plain text.`,
  ].filter(Boolean).join("\n");

  const ephemeral: Agent = {
    ...agent,
    id: `${agent.id}-tool-step`,
    name: `${agent.name} (tool: ${step.toolName ?? "unknown"})`,
    ephemeral: true,
    systemPrompt: `${agent.systemPrompt}\n\n[Workflow constraint] You may only invoke the tool "${step.toolName}". Follow the operator's output convention exactly.`,
  };

  const result = await runSubAgent(ephemeral, promptParts);
  if (result.error) throw new Error(result.error);
  return result.output;
}

function buildDelegateTask(step: WorkflowStep, ctx: RunContext): string {
  const deps = (step.dependencies ?? [])
    .map((d) => {
      const out = ctx.outputs.get(d);
      const summary = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
      return summary ? `- ${d}: ${summary.slice(0, 4000)}` : `- ${d}: (no textual output)`;
    })
    .join("\n");
  const inputJson = step.input == null ? "" : `\n\nInput:\n${JSON.stringify(step.input, null, 2)}`;
  const convention = step.outputConvention ? `\n\nOutput convention: ${step.outputConvention}` : "";
  const upstream = deps ? `\n\nUpstream step outputs:\n${deps}` : "";
  return `Workflow step "${step.id}" in workflow "${ctx.workflow.name}".${inputJson}${upstream}${convention}`;
}

async function runStepOnce(step: WorkflowStep, ctx: RunContext): Promise<unknown> {
  if (step.type === "ag-ui") return step.input ?? null;
  if (step.type === "delegate") return runDelegateStep(step, ctx);
  if (step.type === "tool") return runToolStep(step, ctx);
  throw new Error(`Unknown step type: ${step.type}`);
}

async function runStep(
  step: WorkflowStep,
  ctx: RunContext,
  emit: (ev: ExecutionEvent) => void,
): Promise<StepResult> {
  const retryLimit = step.retryLimit ?? ctx.workflow.config?.defaultRetryLimit ?? 1;
  const timeout = step.timeout ?? ctx.workflow.config?.defaultTimeout;
  let attempt = 0;
  let lastError = "";

  while (attempt < retryLimit) {
    attempt++;
    if (ctx.abortSignal.aborted) {
      return { status: "cancelled", attempts: attempt - 1, error: "aborted" };
    }
    emit(makeEvent(ctx.workflow.id, "step.start", { stepId: step.id, attempt }));
    try {
      const out = await withTimeout(runStepOnce(step, ctx), timeout, ctx.abortSignal);
      if (step.type === "ag-ui") {
        emit(makeEvent(ctx.workflow.id, "ag-ui", { stepId: step.id, payload: out }));
      }
      emit(makeEvent(ctx.workflow.id, "step.complete", { stepId: step.id, attempt, payload: out }));
      return { status: "complete", attempts: attempt, output: out };
    } catch (err) {
      lastError = (err as Error).message;
      if (lastError === "aborted") {
        emit(makeEvent(ctx.workflow.id, "step.fail", { stepId: step.id, attempt, error: "cancelled" }));
        return { status: "cancelled", attempts: attempt, error: "cancelled" };
      }
      const transient = isTransientError(err);
      const more = attempt < retryLimit && transient;
      if (more) {
        emit(makeEvent(ctx.workflow.id, "step.retry", { stepId: step.id, attempt, error: lastError }));
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      emit(makeEvent(ctx.workflow.id, "step.fail", { stepId: step.id, attempt, error: lastError }));
      return { status: "failed", attempts: attempt, error: lastError };
    }
  }
  return { status: "failed", attempts: attempt, error: lastError || "exhausted retries" };
}

function buildAdjacency(wf: Workflow) {
  const remainingDeps = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();
  for (const s of wf.steps) {
    remainingDeps.set(s.id, new Set(s.dependencies ?? []));
    dependents.set(s.id, []);
  }
  for (const s of wf.steps) {
    for (const dep of s.dependencies ?? []) {
      const list = dependents.get(dep);
      if (list) list.push(s.id);
    }
  }
  return { remainingDeps, dependents };
}

/** Run a workflow, yielding NDJSON-style events as the graph executes. */
export async function* runWorkflowStream(
  wf: Workflow,
): AsyncGenerator<ExecutionEvent, void, void> {
  await clearExecutionLog(wf.id);

  const steps: Record<string, StepRuntimeState> = {};
  for (const s of wf.steps) steps[s.id] = { status: "queued", attempts: 0 };
  const status: WorkflowRuntimeStatus = {
    workflowId: wf.id,
    state: "RUNNING",
    startedAt: Date.now(),
    steps,
  };
  setRuntimeStatus(status);

  const abort = new AbortController();
  RUNNING.set(wf.id, abort);

  const queue: ExecutionEvent[] = [];
  let resolver: (() => void) | null = null;
  let finished = false;
  const emit = (ev: ExecutionEvent) => {
    queue.push(ev);
    void appendExecutionLog(wf.id, ev).catch(() => {});
    // Mirror step status into the runtime status map for /api/workflows/status.
    if (ev.stepId) {
      if (ev.type === "step.start") updateStepRuntime(wf.id, ev.stepId, { status: "running", attempts: ev.attempt ?? 1, startedAt: ev.ts });
      else if (ev.type === "step.retry") updateStepRuntime(wf.id, ev.stepId, { status: "retrying", attempts: ev.attempt ?? 1, lastError: ev.error });
      else if (ev.type === "step.complete") updateStepRuntime(wf.id, ev.stepId, { status: "complete", endedAt: ev.ts, output: ev.payload });
      else if (ev.type === "step.fail") updateStepRuntime(wf.id, ev.stepId, { status: ev.error === "cancelled" ? "cancelled" : "failed", endedAt: ev.ts, lastError: ev.error });
    }
    if (resolver) {
      const r = resolver;
      resolver = null;
      r();
    }
  };

  emit(makeEvent(wf.id, "workflow.start"));

  const ctx: RunContext = { workflow: wf, abortSignal: abort.signal, outputs: new Map() };
  const { remainingDeps, dependents } = buildAdjacency(wf);
  const stepsById = new Map(wf.steps.map((s) => [s.id, s]));
  const maxConcurrency = Math.max(1, wf.config?.maxConcurrentSteps ?? 5);

  const pending = new Set(wf.steps.map((s) => s.id));
  const inFlight = new Set<string>();
  let failed = false;
  let cancelled = false;

  const ready: string[] = [];
  for (const [id, deps] of remainingDeps) if (deps.size === 0) ready.push(id);

  // Drive the scheduler in the background; the generator yields events as they arrive.
  const driver = (async () => {
    try {
      while ((pending.size > 0 || inFlight.size > 0) && !cancelled && !failed) {
        if (abort.signal.aborted) {
          cancelled = true;
          break;
        }
        while (ready.length > 0 && inFlight.size < maxConcurrency) {
          const id = ready.shift()!;
          pending.delete(id);
          inFlight.add(id);
          const step = stepsById.get(id)!;
          void (async () => {
            const res = await runStep(step, ctx, emit);
            inFlight.delete(id);
            if (res.status === "complete") {
              ctx.outputs.set(id, res.output);
              for (const child of dependents.get(id) ?? []) {
                const deps = remainingDeps.get(child);
                if (!deps) continue;
                deps.delete(id);
                if (deps.size === 0 && pending.has(child)) ready.push(child);
              }
            } else if (res.status === "cancelled") {
              cancelled = true;
            } else {
              failed = true;
            }
            const r = resolver;
            resolver = null;
            (r as (() => void) | null)?.();
          })();
        }
        if (inFlight.size === 0 && ready.length === 0) break;
        // Wait for the next emitted event or a settled step.
        await new Promise<void>((res) => (resolver = res));
      }
      if (cancelled) {
        for (const id of pending) updateStepRuntime(wf.id, id, { status: "cancelled" });
        updateWorkflowState(wf.id, "CANCELLED");
        emit(makeEvent(wf.id, "workflow.cancel"));
      } else if (failed) {
        updateWorkflowState(wf.id, "FAILED");
        emit(makeEvent(wf.id, "workflow.fail", { error: "one or more steps failed" }));
      } else {
        updateWorkflowState(wf.id, "COMPLETED");
        emit(makeEvent(wf.id, "workflow.complete"));
      }
    } catch (err) {
      updateWorkflowState(wf.id, "FAILED");
      emit(makeEvent(wf.id, "workflow.fail", { error: (err as Error).message }));
    } finally {
      finished = true;
      RUNNING.delete(wf.id);
      if (resolver) {
        const r = resolver;
        resolver = null;
        r();
      }
    }
  })();

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (finished) break;
      await new Promise<void>((res) => (resolver = res));
    }
  } finally {
    await driver;
  }
}
